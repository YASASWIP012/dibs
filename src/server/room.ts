import { nanoid } from "nanoid";
import type { WebSocket } from "ws";
import { Show, ShowError } from "./domain/show.js";
import type { Buyer, Claim, ClaimReading, ShowEvent } from "./domain/types.js";
import type { Ai } from "./ai/gemini.js";
import type { PayPal } from "./paypal/paypal.js";

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
  private readonly peers = new Set<Peer>();
  private latestFrame?: Buffer;
  /** One queue for the whole show: claims land in the order the server received them. */
  private chatQueue: Promise<unknown> = Promise.resolve();

  constructor(
    holdMs: number,
    private readonly ai: Ai,
    private readonly paypal?: PayPal,
    id?: string,
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
    if (lots.length === 0) return this.reply(buyer, "Nothing is up for sale yet. Hang tight.");
    for (const n of lots) {
      try {
        const claim = this.show.claim(buyer.id, n, text, reading.lang, receivedAt);
        await this.confirmClaim(buyer, claim);
      } catch (err) {
        if (err instanceof ShowError) await this.reply(buyer, err.code === "lot_missing" ? `There's no lot ${n}.` : `Lot ${n} is already sold.`);
        else throw err;
      }
    }
  }

  private async confirmClaim(buyer: Buyer, claim: Claim) {
    const lot = this.show.lots.get(claim.lotNumber)!;
    if (claim.status === "holding") {
      await this.reply(buyer, `@${buyer.handle} lot ${lot.number} (${lot.title}, ${fmt(lot.price.cents)}) is yours. Pay within ${mmss(this.show.holdMs)} to keep it.`);
    } else {
      const pos = this.show.waitlist(claim.lotNumber).findIndex((c) => c.id === claim.id) + 1;
      await this.reply(buyer, `@${buyer.handle} you're number ${pos} in line for lot ${lot.number}. If it isn't paid in time, it's yours.`);
    }
  }

  async reply(buyer: Buyer, text: string) {
    const translated = await this.ai.translate(text, buyer.lang);
    this.show.postChat({ buyerId: buyer.id, handle: "dibs", text: translated, system: true });
  }

  /** Runs every half second. Expired holds roll to the next person, who hears about it in their language. */
  async tick() {
    for (const { lapsed, next } of this.show.tick()) {
      const lot = this.show.lots.get(lapsed.lotNumber)!;
      const lapsedBuyer = this.show.buyers.get(lapsed.buyerId);
      if (lapsedBuyer) await this.reply(lapsedBuyer, `Time ran out on lot ${lot.number}, so it went to the next person in line.`);
      const nextBuyer = next && this.show.buyers.get(next.buyerId);
      if (nextBuyer) {
        await this.reply(nextBuyer, `@${nextBuyer.handle} good news: lot ${lot.number} (${lot.title}, ${fmt(lot.price.cents)}) is yours now. Pay within ${mmss(this.show.holdMs)}.`);
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
    const { id } = await this.paypal.createOrder(this.show.id, buyer.handle, lines, requestId);
    const existing = this.show.orders.get(id);
    return existing ?? this.show.recordOrder(id, buyerId, claims);
  }

  async capture(orderId: string) {
    if (!this.paypal) throw new ShowError("order_missing", "PayPal is not configured");
    const order = this.show.assertCapturable(orderId);
    if (order.status === "captured") return order;
    const res = await this.paypal.captureOrder(orderId);
    if (res.status !== "COMPLETED") throw new Error(`Capture status ${res.status}`);
    const done = this.show.markCaptured(orderId, res.captureId);
    const buyer = this.show.buyers.get(done.buyerId);
    if (buyer) await this.reply(buyer, `Paid, thank you. ${fmt(done.total.cents)} received. The seller will ship it soon.`);
    return done;
  }
}
