import { nanoid } from "nanoid";
import type {
  Buyer,
  BuyerSession,
  ChatMessage,
  Claim,
  Lot,
  Money,
  PendingOrder,
  ShowEvent,
} from "./types.js";

export interface ShowOptions {
  /** How long a claim holds a lot before it rolls to the next person. */
  holdMs: number;
  now?: () => number;
}

export class ShowError extends Error {
  constructor(
    readonly code:
      | "lot_missing"
      | "lot_closed"
      | "buyer_missing"
      | "nothing_to_pay"
      | "order_missing"
      | "order_stale",
    message: string,
  ) {
    super(message);
  }
}

type Listener = (event: ShowEvent) => void;

/**
 * One live show. Everything that decides who gets an item lives here, in plain code.
 * The model only reads chat and describes items; it never decides an outcome.
 */
export class Show {
  readonly id: string;
  readonly lots = new Map<number, Lot>();
  readonly claims = new Map<string, Claim>();
  readonly buyers = new Map<string, Buyer>();
  readonly orders = new Map<string, PendingOrder>();
  readonly chat: ChatMessage[] = [];
  private readonly tokens = new Map<string, string>();
  private readonly listeners = new Set<Listener>();
  private readonly now: () => number;
  holdMs: number;

  constructor(opts: ShowOptions & { id?: string }) {
    this.id = opts.id ?? nanoid(8);
    this.holdMs = opts.holdMs;
    this.now = opts.now ?? Date.now;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ShowEvent) {
    for (const l of this.listeners) l(event);
  }

  // ---------- lots ----------

  openLot(input: { number?: number; title: string; description?: string; priceCents: number; photo?: string; spoken?: string }): Lot {
    const number = input.number ?? this.nextLotNumber();
    const existing = this.lots.get(number);
    if (existing && existing.status !== "open") {
      throw new ShowError("lot_closed", `Lot ${number} already has claims`);
    }
    const lot: Lot = {
      number,
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
      price: { cents: Math.round(input.priceCents), currency: "USD" },
      photo: input.photo ?? existing?.photo,
      status: "open",
      createdAt: existing?.createdAt ?? this.now(),
      spoken: input.spoken ?? existing?.spoken,
    };
    this.lots.set(number, lot);
    this.emit({ type: existing ? "lot.updated" : "lot.opened", lot });
    return lot;
  }

  nextLotNumber(): number {
    let max = 0;
    for (const n of this.lots.keys()) max = Math.max(max, n);
    return max + 1;
  }

  /** The most recently opened lot. Bare claims like "mine!" go here. */
  currentLot(): Lot | undefined {
    let latest: Lot | undefined;
    for (const lot of this.lots.values()) {
      if (!latest || lot.createdAt >= latest.createdAt) latest = lot;
    }
    return latest;
  }

  // ---------- buyers & chat ----------

  /** Joins a buyer. Handles are unique per show, so a taken handle gets a number on the end. */
  join(handle: string, lang = "en"): BuyerSession {
    const base = handle.trim().replace(/^@/, "").replace(/[^\p{L}\p{N}_.-]/gu, "").slice(0, 24) || "guest";
    let clean = base;
    const taken = (h: string) => [...this.buyers.values()].some((b) => b.handle.toLowerCase() === h.toLowerCase());
    for (let n = 2; taken(clean); n++) clean = `${base.slice(0, 21)}${n}`;
    const buyer: Buyer = { id: nanoid(10), handle: clean, lang, joinedAt: this.now() };
    this.buyers.set(buyer.id, buyer);
    const token = nanoid(32);
    this.tokens.set(token, buyer.id);
    return { ...buyer, token };
  }

  /** The buyer a secret token belongs to. Public buyer ids are never accepted for actions. */
  buyerByToken(token: string | undefined): Buyer | undefined {
    const id = token ? this.tokens.get(token) : undefined;
    return id ? this.buyers.get(id) : undefined;
  }

  postChat(message: Omit<ChatMessage, "id" | "at"> & { at?: number }): ChatMessage {
    const msg: ChatMessage = { id: nanoid(10), at: message.at ?? this.now(), ...message };
    this.chat.push(msg);
    if (this.chat.length > 500) this.chat.shift();
    this.emit({ type: "chat", message: msg });
    return msg;
  }

  caption(text: string) {
    this.emit({ type: "caption", text, at: this.now() });
  }

  // ---------- claims ----------

  /**
   * Records a claim. The first claim on an open lot holds it; later ones wait in line,
   * ordered by when the server received them.
   */
  claim(buyerId: string, lotNumber: number, text: string, lang: string, receivedAt = this.now()): Claim {
    const buyer = this.buyers.get(buyerId);
    if (!buyer) throw new ShowError("buyer_missing", "Unknown buyer");
    const lot = this.lots.get(lotNumber);
    if (!lot) throw new ShowError("lot_missing", `There is no lot ${lotNumber}`);
    if (lot.status === "sold") throw new ShowError("lot_closed", `Lot ${lotNumber} is sold`);

    const mine = this.claimsFor(lotNumber).find((c) => c.buyerId === buyerId && (c.status === "holding" || c.status === "waiting"));
    if (mine) return mine;

    const claim: Claim = {
      id: nanoid(10),
      lotNumber,
      buyerId,
      handle: buyer.handle,
      text,
      lang,
      receivedAt,
      status: "waiting",
    };
    this.claims.set(claim.id, claim);
    this.emit({ type: "claim.created", claim });
    if (!this.holder(lotNumber)) this.startHold(claim);
    return claim;
  }

  claimsFor(lotNumber: number): Claim[] {
    return [...this.claims.values()]
      .filter((c) => c.lotNumber === lotNumber)
      .sort((a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id));
  }

  holder(lotNumber: number): Claim | undefined {
    return this.claimsFor(lotNumber).find((c) => c.status === "holding" || c.status === "paid");
  }

  waitlist(lotNumber: number): Claim[] {
    return this.claimsFor(lotNumber).filter((c) => c.status === "waiting");
  }

  private startHold(claim: Claim) {
    const at = this.now();
    claim.status = "holding";
    claim.holdStartedAt = at;
    claim.deadline = at + this.holdMs;
    const lot = this.lots.get(claim.lotNumber);
    if (lot) {
      lot.status = "held";
      this.emit({ type: "lot.updated", lot });
    }
    this.emit({ type: "claim.holding", claim });
  }

  /**
   * Moves every expired hold to the next person in line. Call it on a timer.
   * Returns the claims that lapsed so callers can tell the next buyer.
   */
  tick(): Array<{ lapsed: Claim; next?: Claim }> {
    const at = this.now();
    const out: Array<{ lapsed: Claim; next?: Claim }> = [];
    for (const claim of this.claims.values()) {
      if (claim.status !== "holding" || claim.capturing || claim.deadline === undefined || claim.deadline > at) continue;
      claim.status = "lapsed";
      const next = this.waitlist(claim.lotNumber)[0];
      if (next) {
        this.startHold(next);
      } else {
        const lot = this.lots.get(claim.lotNumber);
        if (lot) {
          lot.status = "open";
          this.emit({ type: "lot.updated", lot });
        }
      }
      this.emit({ type: "claim.lapsed", claim, next });
      out.push({ lapsed: claim, next });
    }
    return out;
  }

  /** Ends an unpaid hold now (seller's call); the next tick passes the lot down the line. */
  releaseHold(lotNumber: number): Claim | undefined {
    const h = this.claimsFor(lotNumber).find((c) => c.status === "holding");
    if (!h) return undefined;
    h.deadline = this.now();
    this.tick();
    return h;
  }

  // ---------- checkout ----------

  /** Claims this buyer is holding right now and hasn't paid for. */
  payable(buyerId: string): Claim[] {
    return [...this.claims.values()].filter((c) => c.buyerId === buyerId && c.status === "holding");
  }

  total(claims: Claim[]): Money {
    let cents = 0;
    for (const c of claims) cents += this.lots.get(c.lotNumber)?.price.cents ?? 0;
    return { cents, currency: "USD" };
  }

  /** Records a PayPal order that covers everything the buyer holds. */
  recordOrder(orderId: string, buyerId: string, claims: Claim[]): PendingOrder {
    if (claims.length === 0) throw new ShowError("nothing_to_pay", "Nothing to pay for");
    const order: PendingOrder = {
      id: orderId,
      buyerId,
      claimIds: claims.map((c) => c.id),
      total: this.total(claims),
      status: "created",
      createdAt: this.now(),
    };
    for (const c of claims) c.orderId = orderId;
    this.orders.set(orderId, order);
    this.emit({ type: "order.created", order });
    return order;
  }

  /**
   * Checks an order can still be captured. A hold that lapsed while the buyer was in the
   * PayPal window means the item already went to someone else, so we refuse to take money.
   */
  assertCapturable(orderId: string): PendingOrder {
    const order = this.orders.get(orderId);
    if (!order) throw new ShowError("order_missing", "Unknown order");
    if (order.status === "captured") return order;
    if (order.status === "capturing") throw new ShowError("order_stale", "This payment is already going through");
    const at = this.now();
    for (const id of order.claimIds) {
      const c = this.claims.get(id);
      if (!c || c.status !== "holding" || (c.deadline ?? 0) <= at) {
        throw new ShowError("order_stale", "One of these items went to the next person in line");
      }
    }
    return order;
  }

  /**
   * Locks the order's claims while PayPal captures, so a hold can't lapse to the next buyer in
   * the middle of a capture that then succeeds (which would sell the lot twice).
   */
  beginCapture(orderId: string): PendingOrder {
    const order = this.assertCapturable(orderId);
    if (order.status === "captured") return order;
    order.status = "capturing";
    for (const id of order.claimIds) {
      const c = this.claims.get(id);
      if (c) c.capturing = true;
    }
    return order;
  }

  /** Capture failed or was denied: unlock, and let the clock carry on from where it was. */
  failCapture(orderId: string, status: "created" | "denied" = "created"): void {
    const order = this.orders.get(orderId);
    if (!order || order.status === "captured") return;
    order.status = status;
    for (const id of order.claimIds) {
      const c = this.claims.get(id);
      if (c) c.capturing = false;
    }
    this.emit({ type: "order.created", order });
  }

  /** Idempotent: a second call with the same order (browser + webhook) changes nothing. */
  markCaptured(orderId: string, captureId?: string): PendingOrder {
    const order = this.orders.get(orderId);
    if (!order) throw new ShowError("order_missing", "Unknown order");
    if (order.status === "captured") return order;
    order.status = "captured";
    order.captureId = captureId;
    for (const id of order.claimIds) {
      const c = this.claims.get(id);
      if (!c) continue;
      c.capturing = false;
      c.status = "paid";
      const lot = this.lots.get(c.lotNumber);
      if (lot) {
        lot.status = "sold";
        this.emit({ type: "lot.updated", lot });
      }
      this.emit({ type: "claim.paid", claim: c });
    }
    this.emit({ type: "order.captured", order });
    return order;
  }

  /** Records a refund PayPal already made (from the co-host or a webhook). Idempotent per refund id. */
  private readonly seenRefunds = new Set<string>();
  recordRefund(captureId: string, cents: number, refundId: string): PendingOrder | undefined {
    if (this.seenRefunds.has(refundId)) return undefined;
    const order = [...this.orders.values()].find((o) => o.captureId === captureId);
    if (!order) return undefined;
    this.seenRefunds.add(refundId);
    order.refundedCents = Math.min(order.total.cents, (order.refundedCents ?? 0) + Math.max(0, Math.round(cents)));
    this.emit({ type: "order.captured", order });
    return order;
  }

  // ---------- recap ----------

  recap() {
    const lots = [...this.lots.values()];
    const claims = [...this.claims.values()];
    const sold = lots.filter((l) => l.status === "sold");
    const rescued = claims.filter((c) => c.status === "paid" && claims.some((o) => o.lotNumber === c.lotNumber && o.status === "lapsed"));
    const cents = (ls: Lot[]) => ls.reduce((s, l) => s + l.price.cents, 0);
    return {
      lots: lots.length,
      sold: sold.length,
      soldCents: cents(sold),
      unsold: lots.filter((l) => l.status !== "sold").length,
      lapsedClaims: claims.filter((c) => c.status === "lapsed").length,
      rescuedLots: rescued.length,
      rescuedCents: cents(rescued.map((c) => this.lots.get(c.lotNumber)!).filter(Boolean)),
      buyers: new Set(claims.filter((c) => c.status === "paid").map((c) => c.buyerId)).size,
      refundedCents: [...this.orders.values()].reduce((s, o) => s + (o.refundedCents ?? 0), 0),
    };
  }

  snapshot() {
    return {
      id: this.id,
      holdMs: this.holdMs,
      lots: [...this.lots.values()],
      claims: [...this.claims.values()],
      buyers: [...this.buyers.values()],
      orders: [...this.orders.values()],
      chat: this.chat.slice(-100),
      recap: this.recap(),
      serverNow: this.now(),
    };
  }
}
