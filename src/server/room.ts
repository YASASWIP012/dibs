import { nanoid } from "nanoid";
import type { WebSocket } from "ws";
import { Show, ShowError } from "./domain/show.js";
import type { Buyer, Claim, ClaimReading, ShowEvent } from "./domain/types.js";
import type { Ai } from "./ai/gemini.js";
import type { Cohost, Proposal } from "./ai/cohost.js";
import type { OrderLine } from "./paypal/paypal.js";

/** The slice of PayPal a room needs. The real one is paypal/paypal.ts; tests pass a fake. */
export interface Payments {
  createOrder(showId: string, buyerHandle: string, lines: OrderLine[], requestId: string, payeeEmail?: string): Promise<{ id: string; status?: string }>;
  captureOrder(orderId: string): Promise<{ status?: string; captureId?: string; captureStatus?: string }>;
  getOrder?(orderId: string): Promise<{ status?: string; captureId?: string; captureStatus?: string }>;
  addTracking?(orderId: string, captureId: string, trackingNumber: string, carrier?: string): Promise<string | undefined>;
}

type Role = "seller" | "buyer" | "watch";
interface Peer {
  socket: WebSocket;
  role: Role;
  buyerId?: string;
}

const fmt = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const mmss = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * A show plus everyone connected to it. Chat goes in, the model reads it, the show decides,
 * and every change is pushed to the seller studio and the buyers' phones.
 */
export class Room {
  readonly show: Show;
  readonly sellerKey = nanoid(24);
  readonly createdAt = Date.now();
  demo = false;
  stopDemo?: () => void;
  /** Set when the server has a co-host; it watches the clock and suggests actions. */
  cohost?: Cohost;
  private readonly nudged = new Set<string>();
  readonly suggestions: Proposal[] = [];
  private readonly peers = new Set<Peer>();
  private latestFrame?: Buffer;
  /** One queue for the whole show: claims land in the order the server received them. */
  private chatQueue: Promise<unknown> = Promise.resolve();

  constructor(
    holdMs: number,
    private readonly ai: Ai,
    private readonly paypal?: Payments,
    id?: string,
    /** The seller's own PayPal account. Unset, payments go to the app's account (fine for the sandbox demo). */
    readonly payeeEmail?: string,
  ) {
    this.show = new Show({ holdMs, id });
    this.show.on((e) => this.broadcast(e));
  }

  // ---------- sockets ----------

  attach(socket: WebSocket, role: Role, buyerId?: string) {
    const peer: Peer = { socket, role, buyerId };
    this.peers.add(peer);
    socket.send(JSON.stringify({ type: "snapshot", show: this.show.snapshot() }));
    if (this.latestFrame && role !== "seller") socket.send(this.latestFrame);
    socket.on("close", () => this.peers.delete(peer));
    socket.on("message", (data, isBinary) => {
      if (role === "seller" && isBinary) this.relayFrame(data as Buffer);
    });
  }

  private relayFrame(frame: Buffer) {
    if (frame.length > 400_000) return;
    this.latestFrame = frame;
    for (const p of this.peers) {
      if (p.role !== "seller" && p.socket.readyState === 1 && p.socket.bufferedAmount < 1_000_000) p.socket.send(frame);
    }
  }

  private broadcast(event: ShowEvent) {
    const msg = JSON.stringify({ type: "event", event, serverNow: Date.now() });
    for (const p of this.peers) {
      if (p.socket.readyState !== 1) continue;
      // chat replies addressed to one buyer only go to that buyer and the seller
      if (event.type === "chat" && event.message.system && p.role === "buyer" && event.message.buyerId !== p.buyerId) continue;
      p.socket.send(msg);
    }
  }

  get viewers() {
    let n = 0;
    for (const p of this.peers) if (p.role === "buyer") n++;
    return n;
  }

  // ---------- chat → claims ----------

  /** Serialized for the whole show, so a slow model read can't let a later claim jump the line. */
  handleChat(buyer: Buyer, text: string, receivedAt = Date.now()) {
    const next = this.chatQueue.then(() => this.processChat(buyer, text, receivedAt)).catch(() => undefined);
    this.chatQueue = next;
    return next;
  }

  private async processChat(buyer: Buyer, text: string, receivedAt: number) {
    const clean = text.trim().slice(0, 280);
    if (!clean) return;
    const current = this.show.currentLot();
    const openLots = [...this.show.lots.values()].filter((l) => l.status !== "sold").map((l) => l.number);
    const reading = await this.ai.readChat(clean, { currentLot: current?.number, openLots });
    if (reading.lang && reading.lang !== "und" && buyer.lang !== reading.lang) buyer.lang = reading.lang;
    this.show.postChat({ buyerId: buyer.id, handle: buyer.handle, text: clean, reading });
    if (reading.kind === "claim") await this.applyClaim(buyer, clean, reading, receivedAt);
  }

  private async applyClaim(buyer: Buyer, text: string, reading: Extract<ClaimReading, { kind: "claim" }>, receivedAt: number) {
    const lots = reading.lotNumbers.length ? reading.lotNumbers : [this.show.currentLot()?.number].filter((n): n is number => n !== undefined);
    if (lots.length === 0) {
      void this.reply(buyer, "Nothing is up for sale yet. Hang tight.");
      return;
    }
    for (const n of lots) {
      try {
        const claim = this.show.claim(buyer.id, n, text, reading.lang, receivedAt);
        this.confirmClaim(buyer, claim);
      } catch (err) {
        if (err instanceof ShowError) void this.reply(buyer, err.code === "lot_missing" ? `There's no lot ${n}.` : `Lot ${n} is already sold.`);
        else throw err;
      }
    }
  }

  private confirmClaim(buyer: Buyer, claim: Claim) {
    const lot = this.show.lots.get(claim.lotNumber)!;
    if (claim.status === "holding") {
      void this.reply(buyer, `@${buyer.handle} lot ${lot.number} (${lot.title}, ${fmt(lot.price.cents)}) is yours. Pay within ${mmss(this.show.holdMs)} to keep it.`);
    } else {
      const pos = this.show.waitlist(claim.lotNumber).findIndex((c) => c.id === claim.id) + 1;
      void this.reply(buyer, `@${buyer.handle} you're number ${pos} in line for lot ${lot.number}. If it isn't paid in time, it's yours.`);
    }
  }

  /**
   * Replies are translated off the chat queue, so a slow model call never delays the next
   * claim. Each buyer's replies still arrive in the order they were written.
   */
  private readonly replyQueue = new Map<string, Promise<unknown>>();
  reply(buyer: Buyer, text: string): Promise<unknown> {
    const prev = this.replyQueue.get(buyer.id) ?? Promise.resolve();
    const next = prev
      .then(() => this.ai.translate(text, buyer.lang))
      .then((translated) => this.show.postChat({ buyerId: buyer.id, handle: "dibs", text: translated, system: true }))
      .catch(() => undefined);
    this.replyQueue.set(buyer.id, next);
    return next;
  }

  /** Runs every half second. Expired holds roll to the next person, who hears about it in their language. */
  private suggest(p: Proposal) {
    this.suggestions.push(p);
    if (this.suggestions.length > 30) this.suggestions.shift();
    const msg = JSON.stringify({ type: "cohost.proposal", proposal: { id: p.id, kind: p.kind, label: p.label } });
    for (const peer of this.peers) if (peer.role !== "buyer" && peer.socket.readyState === 1) peer.socket.send(msg);
  }

  tick() {
    // the co-host watches the clock: a buyer close to running out gets a reminder suggestion
    if (this.cohost) {
      const now = Date.now();
      for (const c of this.show.claims.values()) {
        if (c.status !== "holding" || c.capturing || !c.deadline || this.nudged.has(c.id)) continue;
        const left = c.deadline - now;
        if (left > 0 && left <= Math.min(30_000, this.show.holdMs / 3)) {
          this.nudged.add(c.id);
          this.suggest(this.cohost.suggest(this.show, { kind: "remind", lot: c.lotNumber, handle: c.handle, buyerId: c.buyerId }));
        }
      }
    }
    for (const { lapsed, next } of this.show.tick()) {
      const lot = this.show.lots.get(lapsed.lotNumber)!;
      const lapsedBuyer = this.show.buyers.get(lapsed.buyerId);
      if (lapsedBuyer) void this.reply(lapsedBuyer, `Time ran out on lot ${lot.number}, so it went to the next person in line.`);
      if (!next && this.cohost) {
        // nobody waiting: suggest bringing it back 20% cheaper, rounded to a whole dollar
        const price = Math.max(100, Math.round((lot.price.cents * 0.8) / 100) * 100);
        this.suggest(this.cohost.suggest(this.show, { kind: "relist", lot: lot.number, priceCents: price }));
      }
      const nextBuyer = next && this.show.buyers.get(next.buyerId);
      if (nextBuyer) {
        void this.reply(nextBuyer, `@${nextBuyer.handle} good news: lot ${lot.number} (${lot.title}, ${fmt(lot.price.cents)}) is yours now. Pay within ${mmss(this.show.holdMs)}.`);
      }
    }
  }

  // ---------- checkout ----------

  async checkout(buyerId: string) {
    if (!this.paypal) throw new ShowError("nothing_to_pay", "PayPal is not configured on this server");
    const buyer = this.show.buyers.get(buyerId);
    if (!buyer) throw new ShowError("buyer_missing", "Unknown buyer");
    const claims = this.show.payable(buyerId);
    if (claims.length === 0) throw new ShowError("nothing_to_pay", "You're not holding anything right now");
    const lines = claims.map((claim) => ({ claim, lot: this.show.lots.get(claim.lotNumber)! }));
    const requestId = `${this.show.id}-${buyerId}-${claims.map((c) => c.id).sort().join("-")}`.slice(0, 100);
    const { id } = await this.paypal.createOrder(this.show.id, buyer.handle, lines, requestId, this.payeeEmail);
    const existing = this.show.orders.get(id);
    return existing ?? this.show.recordOrder(id, buyerId, claims);
  }

  /** Marks an order paid and, if PayPal confirmed it too late for some lot, suggests sending that money back. */
  settle(orderId: string, captureId?: string) {
    const done = this.show.markCaptured(orderId, captureId);
    const buyer = this.show.buyers.get(done.buyerId);
    for (const lot of done.needsRefund ?? []) {
      const price = this.show.lots.get(lot)?.price.cents ?? 0;
      if (this.cohost && done.captureId && buyer && !this.flaggedRefunds.has(`${orderId}:${lot}`)) {
        this.flaggedRefunds.add(`${orderId}:${lot}`);
        this.suggest(this.cohost.suggest(this.show, { kind: "refund", lot, amountCents: price, captureId: done.captureId, handle: buyer.handle }));
      }
    }
    return done;
  }
  private readonly flaggedRefunds = new Set<string>();

  async capture(orderId: string) {
    if (!this.paypal) throw new ShowError("order_missing", "PayPal is not configured");
    const order = this.show.beginCapture(orderId);
    if (order.status === "captured") return order;
    let res: { status?: string; captureId?: string; captureStatus?: string };
    try {
      res = await this.paypal.captureOrder(orderId);
    } catch (err) {
      // A timeout or 5xx doesn't mean nothing happened. Ask PayPal before letting the clock
      // hand the lot on; if PayPal can't say either way, the hold stays locked until the
      // webhook settles it.
      const check = await this.paypal.getOrder?.(orderId).catch(() => undefined);
      if (!check) throw new ShowError("order_stale", "We couldn't confirm the payment yet. The item stays reserved while PayPal finishes.");
      if (!check.captureStatus) {
        this.show.failCapture(orderId);
        throw err;
      }
      res = check;
    }
    const captureStatus = res.captureStatus ?? res.status;
    if (captureStatus === "PENDING") {
      const buyer = this.show.buyers.get(order.buyerId);
      if (buyer) void this.reply(buyer, "PayPal is still processing your payment. Your items stay reserved until it clears.");
      return order;
    }
    if (captureStatus !== "COMPLETED") {
      this.show.failCapture(orderId, captureStatus === "DECLINED" ? "denied" : "created");
      throw new ShowError("order_stale", "PayPal didn't complete the payment. Nothing was charged.");
    }
    const done = this.settle(orderId, res.captureId);
    const buyer = this.show.buyers.get(done.buyerId);
    if (buyer) void this.reply(buyer, `Paid, thank you. ${fmt(done.total.cents)} received. The seller will ship it soon.`);
    return done;
  }
}
