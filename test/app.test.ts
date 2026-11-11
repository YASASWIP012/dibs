// HTTP-level tests: the real server, a fake PayPal, no model (rules only).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/server/app.js";
import { Ai } from "../src/server/ai/gemini.js";
import type { Payments } from "../src/server/room.js";

type Built = Awaited<ReturnType<typeof buildApp>>;

function fakePayPal() {
  let n = 0;
  const captureGate: { release?: () => void } = {};
  const p = {
    createOrder: vi.fn(async () => ({ id: `ORDER-${++n}`, status: "CREATED" })),
    captureOrder: vi.fn(async (orderId: string) => {
      if (captureGate.release === undefined && p.slow) await new Promise<void>((r) => (captureGate.release = r));
      if (p.captureThrows) throw new Error("socket hang up");
      return { status: p.nextStatus === "PENDING" ? "COMPLETED" : p.nextStatus, captureId: `CAP-${orderId}`, captureStatus: p.nextStatus };
    }),
    getOrder: vi.fn(async (orderId: string) => {
      if (p.lookup === "throws") throw new Error("still down");
      return p.lookup === "captured" ? { status: "COMPLETED", captureId: `CAP-${orderId}`, captureStatus: "COMPLETED" } : { status: "APPROVED" };
    }),
    nextStatus: "COMPLETED" as string,
    captureThrows: false,
    lookup: "approved" as "approved" | "captured" | "throws",
    slow: false,
    captureGate,
  };
  return p;
}

let built: Built;
let pp: ReturnType<typeof fakePayPal>;
let verified = true;

beforeEach(async () => {
  pp = fakePayPal();
  verified = true;
  built = await buildApp({
    ai: new Ai(undefined, "none"),
    payments: pp as unknown as Payments,
    webhooks: { verify: async () => verified },
    holdSeconds: 60,
    demoBuyer: { email: "buyer@example.com", password: "sandbox-only" },
    staticDir: "/nonexistent",
    logger: false,
  });
});
afterEach(async () => {
  vi.useRealTimers();
  for (const r of built.rooms.values()) r.stopDemo?.();
  await built.app.close();
});

const post = async (url: string, payload: unknown, headers: Record<string, string> = {}) => {
  const res = await built.app.inject({ method: "POST", url, payload: payload as object, headers });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
};

async function showWithLot(holdSeconds = 60) {
  const { body: s } = await post("/api/shows", { holdSeconds });
  await post(`/api/shows/${s.showId}/lots`, { title: "Denim jacket", priceCents: 4000, number: 1 }, { "x-seller-key": s.sellerKey });
  return s as { showId: string; sellerKey: string };
}
const join = async (showId: string, handle: string) => (await post(`/api/shows/${showId}/join`, { handle })).body.buyer as { id: string; token: string; handle: string };
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("buyers", () => {
  it("claims through the chat with their secret token", async () => {
    const s = await showWithLot();
    const maria = await join(s.showId, "maria");
    expect(maria.token).toHaveLength(32);
    expect((await post(`/api/shows/${s.showId}/chat`, { token: maria.token, text: "yo quiero el 1" })).status).toBe(200);
    await settle();
    const room = built.rooms.get(s.showId)!;
    expect(room.show.holder(1)?.handle).toBe("maria");
  });

  it("can't act with someone else's public id", async () => {
    const s = await showWithLot();
    const maria = await join(s.showId, "maria");
    const res = await post(`/api/shows/${s.showId}/chat`, { token: maria.id.padEnd(16, "x"), text: "mine" });
    expect(res.status).toBe(403);
  });

  it("never leaks tokens in the public snapshot", async () => {
    const s = await showWithLot();
    const maria = await join(s.showId, "maria");
    const snap = await built.app.inject({ method: "GET", url: `/api/shows/${s.showId}` });
    expect(snap.body).not.toContain(maria.token);
  });

  it("gives a taken handle a number instead of merging two people", async () => {
    const s = await showWithLot();
    const a = await join(s.showId, "maria");
    const b = await join(s.showId, "Maria");
    expect(a.id).not.toBe(b.id);
    expect(b.handle).toBe("Maria2");
  });
});

describe("checkout", () => {
  async function holding() {
    const s = await showWithLot();
    const maria = await join(s.showId, "maria");
    await post(`/api/shows/${s.showId}/chat`, { token: maria.token, text: "mine" });
    await settle();
    return { s, maria };
  }

  it("creates one PayPal order and captures it once", async () => {
    const { s, maria } = await holding();
    const { body: co } = await post(`/api/shows/${s.showId}/checkout`, { token: maria.token });
    expect(pp.createOrder).toHaveBeenCalledTimes(1);
    const cap = await post(`/api/shows/${s.showId}/capture`, { token: maria.token, orderId: co.orderId });
    expect(cap.status).toBe(200);
    expect(cap.body.order.status).toBe("captured");
    const again = await post(`/api/shows/${s.showId}/capture`, { token: maria.token, orderId: co.orderId });
    expect(again.status).toBe(200);
    expect(pp.captureOrder).toHaveBeenCalledTimes(1);
    expect(built.rooms.get(s.showId)!.show.lots.get(1)?.status).toBe("sold");
  });

  it("won't capture another buyer's order", async () => {
    const { s, maria } = await holding();
    const jake = await join(s.showId, "jake");
    const { body: co } = await post(`/api/shows/${s.showId}/checkout`, { token: maria.token });
    expect((await post(`/api/shows/${s.showId}/capture`, { token: jake.token, orderId: co.orderId })).status).toBe(403);
  });

  it("refuses to capture after the hold ran out, without calling PayPal", async () => {
    const { s, maria } = await holding();
    const { body: co } = await post(`/api/shows/${s.showId}/checkout`, { token: maria.token });
    const show = built.rooms.get(s.showId)!.show;
    show.holder(1)!.deadline = Date.now() - 1;
    built.tick();
    const cap = await post(`/api/shows/${s.showId}/capture`, { token: maria.token, orderId: co.orderId });
    expect(cap.status).toBe(409);
    expect(pp.captureOrder).not.toHaveBeenCalled();
  });

  it("does not hand the lot on while PayPal is capturing", async () => {
    const { s, maria } = await holding();
    const jake = await join(s.showId, "jake");
    await post(`/api/shows/${s.showId}/chat`, { token: jake.token, text: "mine" });
    await settle();
    const { body: co } = await post(`/api/shows/${s.showId}/checkout`, { token: maria.token });
    pp.slow = true;
    const capturing = post(`/api/shows/${s.showId}/capture`, { token: maria.token, orderId: co.orderId });
    await settle();
    const show = built.rooms.get(s.showId)!.show;
    show.holder(1)!.deadline = Date.now() - 1; // the clock runs out mid-capture
    built.tick();
    expect(show.holder(1)?.handle).toBe("maria");
    pp.captureGate.release!();
    expect((await capturing).status).toBe(200);
    expect(show.holder(1)?.handle).toBe("maria");
    expect(show.waitlist(1).map((c) => c.handle)).toEqual(["jake"]);
  });

  it("unlocks the hold when PayPal declines, and charges nothing", async () => {
    const { s, maria } = await holding();
    const { body: co } = await post(`/api/shows/${s.showId}/checkout`, { token: maria.token });
    pp.nextStatus = "DECLINED";
    const cap = await post(`/api/shows/${s.showId}/capture`, { token: maria.token, orderId: co.orderId });
    expect(cap.status).toBe(409);
    const show = built.rooms.get(s.showId)!.show;
    expect(show.orders.get(co.orderId)?.status).toBe("denied");
    expect(show.claimsFor(1).find((c) => c.handle === "maria")?.capturing).toBe(false);
    expect(show.lots.get(1)?.status).toBe("held");
  });

  it("sends the order to the seller's own PayPal account when they gave one", async () => {
    const { body: s } = await post("/api/shows", { payeeEmail: "seller@business.example.com" });
    await post(`/api/shows/${s.showId}/lots`, { title: "Lamp", priceCents: 2800, number: 1 }, { "x-seller-key": s.sellerKey });
    const b = await join(s.showId, "ana");
    await post(`/api/shows/${s.showId}/chat`, { token: b.token, text: "mine" });
    await settle();
    await post(`/api/shows/${s.showId}/checkout`, { token: b.token });
    expect((pp.createOrder.mock.calls[0] as unknown[] | undefined)?.[4]).toBe("seller@business.example.com");
  });
});

describe("webhooks", () => {
  async function paidOrder() {
    const s = await showWithLot();
    const maria = await join(s.showId, "maria");
    await post(`/api/shows/${s.showId}/chat`, { token: maria.token, text: "mine" });
    await settle();
    const { body: co } = await post(`/api/shows/${s.showId}/checkout`, { token: maria.token });
    return { s, orderId: co.orderId as string, show: built.rooms.get(s.showId)!.show };
  }
  const completed = (id: string, orderId: string) => ({ id, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: `CAP-${orderId}`, supplementary_data: { related_ids: { order_id: orderId } } } });

  it("ignores a delivery PayPal can't verify", async () => {
    const { orderId, show } = await paidOrder();
    verified = false;
    expect((await post("/api/paypal/webhook", completed("WH-1", orderId))).status).toBe(400);
    expect(show.orders.get(orderId)?.status).toBe("created");
  });

  it("marks the sale from a verified capture, once per event", async () => {
    const { orderId, show } = await paidOrder();
    expect((await post("/api/paypal/webhook", completed("WH-2", orderId))).body.verified).toBe(true);
    expect(show.lots.get(1)?.status).toBe("sold");
    expect((await post("/api/paypal/webhook", completed("WH-2", orderId))).body.duplicate).toBe(true);
  });

  it("records a refund from its capture link", async () => {
    const { orderId, show } = await paidOrder();
    await post("/api/paypal/webhook", completed("WH-3", orderId));
    await post("/api/paypal/webhook", { id: "WH-4", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "REF-1", amount: { value: "25.00" }, links: [{ rel: "up", href: `https://api-m.sandbox.paypal.com/v2/payments/captures/CAP-${orderId}` }] } });
    expect(show.orders.get(orderId)?.refundedCents).toBe(2500);
    expect(show.recap().refundedCents).toBe(2500);
  });
});

describe("judge mode", () => {
  it("hands out the sandbox buyer only with a demo show", async () => {
    const cfg = await built.app.inject({ method: "GET", url: "/api/config" });
    expect(cfg.body).not.toContain("sandbox-only");
    const { body } = await post("/api/demo", {});
    expect(body.demoBuyer.email).toBe("buyer@example.com");
  });
});

describe("capture when PayPal is unreliable", () => {
  async function ordered() {
    const s = await showWithLot();
    const maria = await join(s.showId, "maria");
    const jake = await join(s.showId, "jake");
    await post(`/api/shows/${s.showId}/chat`, { token: maria.token, text: "mine" });
    await post(`/api/shows/${s.showId}/chat`, { token: jake.token, text: "mine" });
    await settle();
    const { body: co } = await post(`/api/shows/${s.showId}/checkout`, { token: maria.token });
    return { s, maria, jake, orderId: co.orderId as string, show: built.rooms.get(s.showId)!.show };
  }

  it("asks PayPal after a timeout, and counts the sale when the capture went through", async () => {
    const { s, maria, orderId, show } = await ordered();
    pp.captureThrows = true;
    pp.lookup = "captured";
    const cap = await post(`/api/shows/${s.showId}/capture`, { token: maria.token, orderId });
    expect(cap.status).toBe(200);
    expect(pp.getOrder).toHaveBeenCalledWith(orderId);
    expect(show.lots.get(1)?.status).toBe("sold");
  });

  it("keeps the item reserved when PayPal can't be reached at all", async () => {
    const { s, maria, orderId, show } = await ordered();
    pp.captureThrows = true;
    pp.lookup = "throws";
    expect((await post(`/api/shows/${s.showId}/capture`, { token: maria.token, orderId })).status).toBe(409);
    show.holder(1)!.deadline = Date.now() - 1;
    built.tick();
    expect(show.holder(1)?.handle).toBe("maria"); // not handed to jake while the outcome is unknown
  });

  it("unlocks when PayPal confirms nothing was captured", async () => {
    const { s, maria, orderId, show } = await ordered();
    pp.captureThrows = true;
    pp.lookup = "approved";
    expect((await post(`/api/shows/${s.showId}/capture`, { token: maria.token, orderId })).status).toBe(500);
    expect(show.claimsFor(1).find((c) => c.handle === "maria")?.capturing).toBe(false);
  });

  it("treats a PENDING capture as reserved, not sold, until the webhook says so", async () => {
    const { s, maria, orderId, show } = await ordered();
    pp.nextStatus = "PENDING";
    expect((await post(`/api/shows/${s.showId}/capture`, { token: maria.token, orderId })).status).toBe(200);
    expect(show.lots.get(1)?.status).toBe("held");
    show.holder(1)!.deadline = Date.now() - 1;
    built.tick();
    expect(show.holder(1)?.handle).toBe("maria");
    await post("/api/paypal/webhook", { id: "WH-P1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: `CAP-${orderId}`, supplementary_data: { related_ids: { order_id: orderId } } } });
    expect(show.lots.get(1)?.status).toBe("sold");
  });

  it("never sells a lot twice when PayPal confirms after the lot moved on", async () => {
    const { orderId, show } = await ordered();
    // maria's hold lapses before anyone captured; jake now holds lot 1
    show.holder(1)!.deadline = Date.now() - 1;
    built.tick();
    expect(show.holder(1)?.handle).toBe("jake");
    // then PayPal reports maria's capture anyway
    await post("/api/paypal/webhook", { id: "WH-L1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: `CAP-${orderId}`, supplementary_data: { related_ids: { order_id: orderId } } } });
    expect(show.holder(1)?.handle).toBe("jake");
    expect(show.lots.get(1)?.status).toBe("held");
    expect(show.orders.get(orderId)?.needsRefund).toEqual([1]);
  });
});

describe("limits", () => {
  it("slows down one address creating shows in bulk", async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await post("/api/shows", {})).status;
    expect(last).toBe(429);
  });
});
