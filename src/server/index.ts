import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { config, paypalReady } from "./config.js";
import { Ai } from "./ai/gemini.js";
import { Cohost } from "./ai/cohost.js";
import { PayPal } from "./paypal/paypal.js";
import { Room } from "./room.js";
import { ShowError } from "./domain/show.js";
import { runDemo } from "./demo.js";

const app = Fastify({ logger: { level: "info" }, bodyLimit: 2_000_000 });
await app.register(websocket, { options: { maxPayload: 500_000 } });

const ai = new Ai(config.GEMINI_API_KEY, config.GEMINI_MODEL, config.GEMINI_VISION_MODEL);
const paypal = paypalReady ? new PayPal({ clientId: config.PAYPAL_CLIENT_ID!, clientSecret: config.PAYPAL_CLIENT_SECRET! }) : undefined;
const cohost =
  paypalReady && config.GEMINI_API_KEY
    ? new Cohost({ clientId: config.PAYPAL_CLIENT_ID!, clientSecret: config.PAYPAL_CLIENT_SECRET!, geminiKey: config.GEMINI_API_KEY, model: config.GEMINI_AGENT_MODEL })
    : undefined;

const rooms = new Map<string, Room>();
let webhookId = config.PAYPAL_WEBHOOK_ID;

const WEBHOOK_EVENTS = ["CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED"];

setInterval(() => {
  for (const room of rooms.values()) void room.tick();
}, 500).unref();

function room(id: string): Room {
  const r = rooms.get(id);
  if (!r) throw new ShowError("lot_missing", "This show doesn't exist or has ended");
  return r;
}

function requireSeller(r: Room, key: unknown) {
  if (typeof key !== "string" || key !== r.sellerKey) {
    const err = new Error("Only the seller can do that") as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
}

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ShowError) return reply.status(err.code === "order_stale" ? 409 : 400).send({ error: err.code, message: err.message });
  if (err instanceof z.ZodError) return reply.status(400).send({ error: "bad_request", message: err.issues[0]?.message });
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) app.log.error(err);
  return reply.status(status).send({ error: "error", message: status >= 500 ? "Something went wrong on our side" : (err as Error).message });
});

// ---------- public config ----------

app.get("/api/config", async () => ({
  paypalClientId: config.PAYPAL_CLIENT_ID ?? null,
  ai: ai.enabled,
  holdSeconds: config.HOLD_SECONDS,
  // sandbox-only test buyer so judges can pay without making an account
  demoBuyer: config.DEMO_BUYER_EMAIL ? { email: config.DEMO_BUYER_EMAIL, password: config.DEMO_BUYER_PASSWORD } : null,
}));

app.get("/api/health", async () => ({ ok: true, rooms: rooms.size, ai: { model: ai.model, ...ai.stats }, paypal: paypalReady, webhook: Boolean(webhookId) }));

// ---------- shows ----------

app.post("/api/shows", async (req) => {
  const body = z.object({ holdSeconds: z.number().int().min(15).max(3600).optional() }).parse(req.body ?? {});
  const r = new Room((body.holdSeconds ?? config.HOLD_SECONDS) * 1000, ai, paypal);
  rooms.set(r.show.id, r);
  return { showId: r.show.id, sellerKey: r.sellerKey };
});

app.get("/api/shows/:id", async (req) => {
  const { id } = req.params as { id: string };
  const r = room(id);
  return { ...r.show.snapshot(), viewers: r.viewers };
});

app.post("/api/shows/:id/lots", async (req) => {
  const { id } = req.params as { id: string };
  const r = room(id);
  requireSeller(r, req.headers["x-seller-key"]);
  const body = z
    .object({
      spoken: z.string().max(400).default(""),
      frame: z.string().max(600_000).optional(),
      // seller edits skip the model
      title: z.string().max(60).optional(),
      description: z.string().max(200).optional(),
      priceCents: z.number().int().min(0).max(1_000_000).optional(),
      number: z.number().int().positive().max(999).optional(),
    })
    .parse(req.body);
  const frameB64 = body.frame?.replace(/^data:image\/jpeg;base64,/, "");
  const draft = body.title ? null : await ai.describeLot(body.spoken, frameB64);
  const lot = r.show.openLot({
    number: body.number ?? draft?.number ?? undefined,
    title: body.title ?? draft?.title ?? "New item",
    description: body.description ?? draft?.description ?? "",
    priceCents: body.priceCents ?? draft?.priceCents ?? 0,
    photo: body.frame,
    spoken: body.spoken || undefined,
  });
  return { lot, via: draft?.via ?? "seller" };
});

app.post("/api/shows/:id/caption", async (req) => {
  const { id } = req.params as { id: string };
  const r = room(id);
  requireSeller(r, req.headers["x-seller-key"]);
  const { text } = z.object({ text: z.string().max(400) }).parse(req.body);
  r.show.caption(text);
  return { ok: true };
});

app.post("/api/shows/:id/join", async (req) => {
  const { id } = req.params as { id: string };
  const { handle, lang } = z.object({ handle: z.string().min(1).max(24), lang: z.string().max(8).optional() }).parse(req.body);
  const buyer = room(id).show.join(handle, lang ?? "en");
  return { buyer };
});

app.post("/api/shows/:id/chat", async (req) => {
  const { id } = req.params as { id: string };
  const r = room(id);
  const { buyerId, text } = z.object({ buyerId: z.string(), text: z.string().min(1).max(280) }).parse(req.body);
  const buyer = r.show.buyers.get(buyerId);
  if (!buyer) throw new ShowError("buyer_missing", "Join the show first");
  void r.handleChat(buyer, text, Date.now());
  return { ok: true };
});

app.post("/api/shows/:id/checkout", async (req) => {
  const { id } = req.params as { id: string };
  const { buyerId } = z.object({ buyerId: z.string() }).parse(req.body);
  const order = await room(id).checkout(buyerId);
  return { orderId: order.id, total: order.total };
});

app.post("/api/shows/:id/capture", async (req) => {
  const { id } = req.params as { id: string };
  const { orderId } = z.object({ orderId: z.string() }).parse(req.body);
  const order = await room(id).capture(orderId);
  return { order };
});

app.post("/api/shows/:id/cohost", async (req) => {
  const { id } = req.params as { id: string };
  const r = room(id);
  requireSeller(r, req.headers["x-seller-key"]);
  if (!cohost) return { text: "The co-host needs PayPal and Gemini keys on the server.", steps: [] };
  const { question } = z.object({ question: z.string().min(1).max(500) }).parse(req.body);
  return cohost.ask(r.show, question);
});

// ---------- judge mode ----------

app.post("/api/demo", async () => {
  const r = new Room(40_000, ai, paypal);
  r.demo = true;
  r.stopDemo = runDemo(r);
  rooms.set(r.show.id, r);
  return { showId: r.show.id };
});

// Shows nobody touched for six hours are dropped.
setInterval(() => {
  for (const [id, r] of rooms) if (Date.now() - r.createdAt > 6 * 3600_000) {
    r.stopDemo?.();
    rooms.delete(id);
  }
}, 600_000).unref();

// ---------- PayPal webhooks ----------

app.post("/api/paypal/webhook", async (req, reply) => {
  const event = req.body as { id?: string; event_type?: string; resource?: { id?: string; supplementary_data?: { related_ids?: { order_id?: string } } } };
  if (!paypal || !webhookId || !event?.id) return reply.status(202).send({ ok: false });
  const verified = await paypal.verifyWebhook(webhookId, req.headers, req.body).catch(() => false);
  const orderId = event.resource?.supplementary_data?.related_ids?.order_id ?? (event.event_type === "CHECKOUT.ORDER.APPROVED" ? event.resource?.id : undefined);
  for (const r of rooms.values()) {
    const order = orderId ? r.show.orders.get(orderId) : undefined;
    if (!order) continue;
    r.show.postChat({ buyerId: order.buyerId, handle: "paypal", text: `${event.event_type}${verified ? "" : " (unverified, ignored)"}`, system: true });
    if (verified && event.event_type === "PAYMENT.CAPTURE.COMPLETED") r.show.markCaptured(order.id, event.resource?.id);
  }
  return { ok: true, verified };
});

// ---------- realtime ----------

app.register(async (scope) => {
  scope.get("/ws/:id", { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { role?: string; key?: string; buyer?: string };
    const r = rooms.get(id);
    if (!r) return socket.close(4404, "no show");
    if (q.role === "seller") {
      if (q.key !== r.sellerKey) return socket.close(4403, "not the seller");
      r.attach(socket, "seller");
    } else if (q.role === "watch" && r.demo) {
      r.attach(socket, "watch");
    } else {
      r.attach(socket, "buyer", q.buyer);
    }
  });
});

// ---------- web app ----------

const dist = resolve("dist");
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/ws")) return reply.status(404).send({ error: "not_found" });
    return reply.sendFile("index.html");
  });
}

await app.listen({ port: config.PORT, host: "0.0.0.0" });

if (paypal && config.PUBLIC_URL && !webhookId) {
  paypal
    .ensureWebhook(`${config.PUBLIC_URL.replace(/\/$/, "")}/api/paypal/webhook`, WEBHOOK_EVENTS)
    .then((id) => {
      webhookId = id;
      app.log.info({ webhookId: id }, "PayPal webhook ready");
    })
    .catch((err) => app.log.warn({ err: String(err) }, "Could not register the PayPal webhook"));
}

export { app, rooms };
