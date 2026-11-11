import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { Ai } from "./ai/gemini.js";
import type { Cohost } from "./ai/cohost.js";
import { Room, type Payments } from "./room.js";
import { ShowError } from "./domain/show.js";
import { runDemo } from "./demo.js";

export interface Webhooks {
  /** true only when PayPal confirms the delivery is genuine */
  verify(headers: Record<string, string | string[] | undefined>, body: unknown): Promise<boolean>;
}

export interface Deps {
  ai: Ai;
  payments?: Payments;
  webhooks?: Webhooks;
  cohost?: Cohost;
  paypalClientId?: string;
  holdSeconds: number;
  youtubeKey?: string;
  demoBuyer?: { email: string; password?: string };
  staticDir?: string;
  logger?: boolean;
}

type WebhookEvent = {
  id?: string;
  event_type?: string;
  resource?: {
    id?: string;
    status?: string;
    amount?: { value?: string };
    supplementary_data?: { related_ids?: { order_id?: string } };
    links?: Array<{ rel?: string; href?: string }>;
    disputed_transactions?: Array<{ seller_transaction_id?: string }>;
  };
};

const Token = z.string().min(16).max(64);
const forbidden = (message: string) => Object.assign(new Error(message), { statusCode: 403 });

/** Builds the HTTP and WebSocket server. Everything external comes in through `deps`, so tests run it with fakes. */
export async function buildApp(deps: Deps): Promise<{ app: FastifyInstance; rooms: Map<string, Room>; tick: () => void }> {
  const app = Fastify({ logger: deps.logger === false ? false : { level: "info" }, bodyLimit: 2_000_000 });
  await app.register(websocket, { options: { maxPayload: 500_000 } });
  const rooms = new Map<string, Room>();
  const seenEvents = new Set<string>();

  const room = (id: string): Room => {
    const r = rooms.get(id);
    if (!r) throw new ShowError("lot_missing", "This show doesn't exist or has ended");
    return r;
  };
  const requireSeller = (r: Room, key: unknown) => {
    if (typeof key !== "string" || key !== r.sellerKey) throw forbidden("Only the seller can do that");
  };
  const buyerFrom = (r: Room, token: string) => {
    const b = r.show.buyerByToken(token);
    if (!b) throw forbidden("Join the show first");
    return b;
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ShowError) return reply.status(err.code === "order_stale" ? 409 : 400).send({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "bad_request", message: err.issues[0]?.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.status(status).send({ error: "error", message: status >= 500 ? "Something went wrong on our side" : (err as Error).message });
  });

  // A small per-address limit on creating shows, so one visitor can't flood the server.
  const created = new Map<string, number[]>();
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "POST" || (req.url !== "/api/shows" && req.url !== "/api/demo")) return;
    const now = Date.now();
    const recent = (created.get(req.ip) ?? []).filter((t) => now - t < 10 * 60_000);
    if (recent.length >= 30) return reply.status(429).send({ error: "slow_down", message: "Too many shows from here. Try again in a few minutes." });
    recent.push(now);
    created.set(req.ip, recent);
  });

  // ---------- public config ----------

  app.get("/api/config", async () => ({ paypalClientId: deps.paypalClientId ?? null, ai: deps.ai.enabled, holdSeconds: deps.holdSeconds }));
  app.get("/api/health", async () => ({ ok: true, rooms: rooms.size, ai: { model: deps.ai.model, ...deps.ai.stats }, paypal: Boolean(deps.payments), webhook: Boolean(deps.webhooks) }));

  // ---------- shows ----------

  app.post("/api/shows", async (req) => {
    const body = z.object({ holdSeconds: z.number().int().min(15).max(3600).optional(), payeeEmail: z.string().email().max(120).optional() }).parse(req.body ?? {});
    const r = new Room((body.holdSeconds ?? deps.holdSeconds) * 1000, deps.ai, deps.payments, undefined, body.payeeEmail);
    r.cohost = deps.cohost;
    rooms.set(r.show.id, r);
    return { showId: r.show.id, sellerKey: r.sellerKey };
  });

  app.get("/api/shows/:id", async (req) => {
    const r = room((req.params as { id: string }).id);
    return { ...r.show.snapshot(), viewers: r.viewers };
  });

  app.get("/api/shows/:id/suggestions", async (req) => {
    const r = room((req.params as { id: string }).id);
    requireSeller(r, req.headers["x-seller-key"]);
    return { suggestions: r.suggestions.map(({ id, kind, label }) => ({ id, kind, label })) };
  });

  app.post("/api/shows/:id/lots", async (req) => {
    const r = room((req.params as { id: string }).id);
    requireSeller(r, req.headers["x-seller-key"]);
    const body = z
      .object({
        spoken: z.string().max(400).default(""),
        frame: z.string().max(600_000).optional(),
        title: z.string().max(60).optional(),
        description: z.string().max(200).optional(),
        priceCents: z.number().int().min(0).max(1_000_000).optional(),
        number: z.number().int().positive().max(999).optional(),
      })
      .parse(req.body);
    const frameB64 = body.frame?.replace(/^data:image\/jpeg;base64,/, "");
    const draft = body.title ? null : await deps.ai.describeLot(body.spoken, frameB64);
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
    const r = room((req.params as { id: string }).id);
    requireSeller(r, req.headers["x-seller-key"]);
    r.show.caption(z.object({ text: z.string().max(400) }).parse(req.body).text);
    return { ok: true };
  });

  app.post("/api/shows/:id/join", async (req) => {
    const body = z
      .object({ handle: z.string().min(1).max(24).optional(), code: z.string().regex(/^\d{4}$/).optional(), lang: z.string().max(8).optional() })
      .refine((b) => b.handle || b.code, "Give a name, or the code the seller read out")
      .parse(req.body);
    const show = room((req.params as { id: string }).id).show;
    if (body.code) {
      const buyer = show.redeemCode(body.code, body.lang ?? "en");
      if (!buyer) throw forbidden("That code doesn't match anyone in this show");
      return { buyer };
    }
    return { buyer: show.join(body.handle!, body.lang ?? "en") };
  });

  // ---------- YouTube Live ----------

  app.post("/api/shows/:id/youtube", async (req) => {
    const r = room((req.params as { id: string }).id);
    requireSeller(r, req.headers["x-seller-key"]);
    if (!deps.youtubeKey) throw new ShowError("lot_missing", "YouTube isn't set up on this server (YOUTUBE_API_KEY).");
    const { url } = z.object({ url: z.string().min(5).max(200) }).parse(req.body);
    return r.connectYouTube(url, deps.youtubeKey);
  });

  app.get("/api/shows/:id/youtube", async (req) => {
    const r = room((req.params as { id: string }).id);
    requireSeller(r, req.headers["x-seller-key"]);
    return { ...r.youtubeStatus, codes: r.show.claimCodes() };
  });

  app.delete("/api/shows/:id/youtube", async (req) => {
    const r = room((req.params as { id: string }).id);
    requireSeller(r, req.headers["x-seller-key"]);
    r.disconnectYouTube();
    return r.youtubeStatus;
  });

  app.post("/api/shows/:id/chat", async (req) => {
    const r = room((req.params as { id: string }).id);
    const { token, text } = z.object({ token: Token, text: z.string().min(1).max(280) }).parse(req.body);
    void r.handleChat(buyerFrom(r, token), text, Date.now());
    return { ok: true };
  });

  app.post("/api/shows/:id/checkout", async (req) => {
    const r = room((req.params as { id: string }).id);
    const { token } = z.object({ token: Token }).parse(req.body);
    const order = await r.checkout(buyerFrom(r, token).id);
    return { orderId: order.id, total: order.total };
  });

  app.post("/api/shows/:id/capture", async (req) => {
    const r = room((req.params as { id: string }).id);
    const { token, orderId } = z.object({ token: Token, orderId: z.string().max(64) }).parse(req.body);
    const buyer = buyerFrom(r, token);
    if (r.show.orders.get(orderId)?.buyerId !== buyer.id) throw forbidden("That order isn't yours");
    return { order: await r.capture(orderId) };
  });

  // ---------- co-host ----------

  app.post("/api/shows/:id/cohost", async (req) => {
    const r = room((req.params as { id: string }).id);
    requireSeller(r, req.headers["x-seller-key"]);
    if (!deps.cohost) return { text: "The co-host needs PayPal and Gemini keys on the server.", steps: [], proposals: [] };
    const { question } = z.object({ question: z.string().min(1).max(500) }).parse(req.body);
    const a = await deps.cohost.ask(r.show, question);
    return { text: a.text, steps: a.steps.map(({ tool, ok }) => ({ tool, ok })), proposals: a.proposals.map(({ id, kind, label }) => ({ id, kind, label })) };
  });

  app.post("/api/shows/:id/cohost/confirm", async (req) => {
    const r = room((req.params as { id: string }).id);
    requireSeller(r, req.headers["x-seller-key"]);
    if (!deps.cohost) throw new ShowError("order_missing", "No co-host on this server");
    const { proposalId } = z.object({ proposalId: z.string().max(20) }).parse(req.body);
    return deps.cohost.confirm(r.show, proposalId, {
      release: (lot) => {
        r.show.releaseHold(lot);
        r.tick();
      },
      track: async (orderId, captureId, trackingNumber, carrier) => deps.payments?.addTracking?.(orderId, captureId, trackingNumber, carrier),
      relist: (lot, priceCents) => {
        const l = r.show.lots.get(lot);
        if (!l) return;
        r.show.openLot({ number: lot, title: l.title, description: l.description, priceCents, photo: l.photo, spoken: l.spoken });
        r.show.caption("Lot " + lot + " is back: " + l.title + ", now $" + (priceCents / 100).toFixed(0));
      },
      remind: async (buyerId, lot) => {
        const b = r.show.buyers.get(buyerId);
        if (b) await r.reply(b, `@${b.handle} lot ${lot} is still waiting for you. Pay soon or it goes to the next person.`);
      },
    });
  });

  // ---------- judge mode ----------

  app.post("/api/demo", async () => {
    const r = new Room(40_000, deps.ai, deps.payments);
    r.cohost = deps.cohost;
    r.demo = true;
    r.stopDemo = runDemo(r);
    rooms.set(r.show.id, r);
    // the sandbox test buyer is only handed out with a judge-mode show
    return { showId: r.show.id, demoBuyer: deps.demoBuyer ?? null };
  });

  // ---------- PayPal webhooks ----------

  app.post("/api/paypal/webhook", async (req, reply) => {
    const event = req.body as WebhookEvent;
    if (!deps.webhooks || !event?.id || !event.event_type) return reply.status(202).send({ ok: false });
    const verified = await deps.webhooks.verify(req.headers, req.body).catch(() => false);
    if (!verified) return reply.status(400).send({ ok: false, verified: false });
    // PayPal retries deliveries; each event changes state at most once
    if (seenEvents.has(event.id)) return { ok: true, verified, duplicate: true };
    seenEvents.add(event.id);
    if (seenEvents.size > 5000) seenEvents.delete(seenEvents.values().next().value!);

    const res = event.resource ?? {};
    const orderId = res.supplementary_data?.related_ids?.order_id ?? (event.event_type === "CHECKOUT.ORDER.APPROVED" ? res.id : undefined);
    // a refund's capture id is the last segment of its "up" link
    const captureOfRefund =
      res.links?.find((l) => l.rel === "up")?.href?.split("/").pop() ??
      (event.event_type === "CUSTOMER.DISPUTE.CREATED" ? res.disputed_transactions?.[0]?.seller_transaction_id : undefined);
    for (const r of rooms.values()) {
      const order = orderId ? r.show.orders.get(orderId) : [...r.show.orders.values()].find((o) => o.captureId && o.captureId === captureOfRefund);
      if (!order) continue;
      r.show.postChat({ buyerId: order.buyerId, handle: "paypal", text: `${event.event_type} · verified`, system: true });
      if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") r.settle(order.id, res.id);
      else if (event.event_type === "PAYMENT.CAPTURE.DENIED") r.show.failCapture(order.id, "denied");
      else if ((event.event_type === "PAYMENT.CAPTURE.REFUNDED" || event.event_type === "PAYMENT.CAPTURE.REVERSED") && order.captureId && res.id)
        r.show.recordRefund(order.captureId, Math.round(Number(res.amount?.value ?? 0) * 100), res.id);
    }
    return { ok: true, verified };
  });

  // ---------- realtime ----------

  app.register(async (scope) => {
    scope.get("/ws/:id", { websocket: true }, (socket, req) => {
      const { id } = req.params as { id: string };
      const q = req.query as { role?: string; key?: string; token?: string };
      const r = rooms.get(id);
      if (!r) return socket.close(4404, "no show");
      if (q.role === "seller") {
        if (q.key !== r.sellerKey) return socket.close(4403, "not the seller");
        r.attach(socket, "seller");
      } else if (q.role === "watch" && r.demo) {
        r.attach(socket, "watch");
      } else {
        // a buyer only receives their own replies when they present their secret token
        r.attach(socket, "buyer", r.show.buyerByToken(q.token)?.id);
      }
    });
  });

  // ---------- web app ----------

  const dist = resolve(deps.staticDir ?? "dist");
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/ws")) return reply.status(404).send({ error: "not_found" });
      return reply.sendFile("index.html");
    });
  }

  // Shows untouched for six hours are dropped.
  const sweep = setInterval(() => {
    for (const [id, r] of rooms) {
      if (Date.now() - r.createdAt > 6 * 3600_000) {
        r.stopDemo?.();
        rooms.delete(id);
      }
    }
  }, 600_000);
  sweep.unref();
  app.addHook("onClose", async () => clearInterval(sweep));

  const tick = () => {
    for (const r of rooms.values()) r.tick();
  };
  return { app, rooms, tick };
}
