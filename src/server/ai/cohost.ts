import { GoogleGenAI, ThinkingLevel, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import { nanoid } from "nanoid";
import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Show } from "../domain/show.js";

export interface CohostStep {
  tool: string;
  args: unknown;
  ok: boolean;
  result?: unknown;
}

/** Something the co-host wants to do. Nothing happens until the seller confirms it. */
export type Proposal =
  | { id: string; kind: "refund"; lot: number; amountCents: number; captureId: string; handle: string; label: string }
  | { id: string; kind: "release"; lot: number; handle: string; label: string }
  | { id: string; kind: "remind"; lot: number; handle: string; buyerId: string; label: string }
  | { id: string; kind: "relist"; lot: number; priceCents: number; label: string }
  | { id: string; kind: "track"; lot: number; orderId: string; captureId: string; carrier: string; trackingNumber: string; label: string };

export interface CohostAnswer {
  text: string;
  steps: CohostStep[];
  proposals: Proposal[];
}

interface LocalTool {
  description: string;
  parameters: ZodTypeAny;
  execute: (args: unknown) => Promise<unknown>;
}

const SYSTEM = [
  "You are the co-host for a small reseller running a live sale. Be brief: one to three short sentences, plain words, no markdown.",
  "Always call show_status first. Money amounts are USD.",
  "You cannot move money or change the show yourself. To refund, release an unpaid hold to the next buyer, or nudge a buyer, call the matching propose_ tool; the seller confirms each proposal with one tap.",
  "Only propose what the seller asked for, or, when asked to wrap up the show, one sensible action per unpaid or problem lot.",
  "When you propose something, say what you proposed in one sentence. If a proposal is refused, say why in one sentence.",
].join(" ");

const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Checks a refund against what PayPal actually captured for that lot. Pure, so it is unit tested. */
export function checkRefund(show: Show, lot: number, amountCents: number): { ok: true; captureId: string; handle: string; maxCents: number } | { ok: false; reason: string } {
  const l = show.lots.get(lot);
  if (!l) return { ok: false, reason: `There is no lot ${lot}.` };
  // a paid claim, or a late capture on a lot that already moved on (money to return)
  const paid = show.claimsFor(lot).find((c) => {
    const o = c.orderId ? show.orders.get(c.orderId) : undefined;
    return o?.status === "captured" && (c.status === "paid" || Boolean(o.needsRefund?.includes(lot)));
  });
  const order = paid?.orderId ? show.orders.get(paid.orderId) : undefined;
  if (!paid || !order || order.status !== "captured" || !order.captureId) return { ok: false, reason: `Lot ${lot} hasn't been paid, so there is nothing to refund.` };
  // capped per lot, and by what is left on the whole capture
  const left = Math.min(l.price.cents - (order.refundedByLot?.[lot] ?? 0), order.total.cents - (order.refundedCents ?? 0));
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, reason: "The refund amount has to be more than zero." };
  if (amountCents > left) return { ok: false, reason: `Lot ${lot} can be refunded at most ${fmt(left)}.` };
  return { ok: true, captureId: order.captureId, handle: paid.handle, maxCents: left };
}

/**
 * The seller's co-host. Ask it things in plain words ("who hasn't paid?", "refund lot 3",
 * "wrap up the show"). It reads the show and PayPal through read-only tools and turns anything
 * that changes money or the show into a proposal. The seller confirms; then Dibs executes it,
 * refunds through the PayPal Agent Toolkit's create_refund.
 *
 * The loop passes the model's own content back each turn, so newer Gemini models keep their
 * thought signatures across tool calls.
 */
export class Cohost {
  private readonly readTools: Record<string, LocalTool>;
  private readonly createRefund: LocalTool;
  private readonly client: GoogleGenAI;
  private readonly proposals = new Map<string, { showId: string; p: Proposal; at: number }>();
  private readonly running = new Set<string>();

  constructor(private readonly opts: { clientId: string; clientSecret: string; geminiKey: string; model: string }) {
    const toolkit = new PayPalAgentToolkit({
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      configuration: {
        actions: {
          orders: { get: true },
          payments: { createRefund: true, getRefunds: true },
          transactions: { list: true },
          shipment: { get: true },
        },
        context: { sandbox: true },
      },
    });
    const all = toolkit.getTools() as unknown as Record<string, LocalTool>;
    const { create_refund, ...read } = all;
    if (!create_refund) throw new Error("PayPal Agent Toolkit has no create_refund tool");
    // the model only ever sees read tools; create_refund runs after the seller confirms
    this.createRefund = create_refund;
    this.readTools = read;
    this.client = new GoogleGenAI({ apiKey: opts.geminiKey, apiVersion: "v1beta" });
  }

  private showTools(show: Show, out: Proposal[]): Record<string, LocalTool> {
    const remember = (p: Proposal) => {
      this.proposals.set(p.id, { showId: show.id, p, at: Date.now() });
      out.push(p);
      return { proposed: p.label, id: p.id, needs: "the seller to confirm" };
    };
    return {
      show_status: {
        description:
          "Current state of this live show: every lot with its price and status, who holds or paid for it, who is waiting, PayPal order ids, capture ids and refunds. Call this before answering anything about the show.",
        parameters: z.object({}),
        execute: async () => {
          const snap = show.snapshot();
          return {
            lots: snap.lots.map((l) => ({
              lot: l.number,
              title: l.title,
              price: (l.price.cents / 100).toFixed(2),
              status: l.status,
              claims: show.claimsFor(l.number).map((c) => {
                const o = c.orderId ? show.orders.get(c.orderId) : undefined;
                return {
                  handle: c.handle,
                  status: c.status,
                  secondsLeft: c.status === "holding" && c.deadline ? Math.max(0, Math.round((c.deadline - snap.serverNow) / 1000)) : undefined,
                  orderId: c.orderId,
                  captureId: o?.captureId,
                  refunded: o?.refundedCents ? fmt(o.refundedCents) : undefined,
                };
              }),
            })),
            recap: snap.recap,
          };
        },
      },
      propose_refund: {
        description: "Propose refunding part or all of a paid lot. The seller confirms before any money moves.",
        parameters: z.object({ lot: z.number().int().positive(), amount: z.number().positive().describe("USD, e.g. 25 or 12.5"), reason: z.string().max(120).optional() }),
        execute: async (a) => {
          const { lot, amount } = a as { lot: number; amount: number };
          const cents = Math.round(amount * 100);
          const c = checkRefund(show, lot, cents);
          if (!c.ok) return { refused: c.reason };
          return remember({ id: nanoid(10), kind: "refund", lot, amountCents: cents, captureId: c.captureId, handle: c.handle, label: `Refund ${fmt(cents)} to @${c.handle} for lot ${lot}` });
        },
      },
      propose_tracking: {
        description: "Propose adding shipping tracking to a paid lot's PayPal order so the buyer is notified. The seller confirms first.",
        parameters: z.object({ lot: z.number().int().positive(), carrier: z.string().min(2).max(30).describe("e.g. USPS, UPS, FEDEX, DHL"), trackingNumber: z.string().min(6).max(40) }),
        execute: async (a) => {
          const { lot, carrier, trackingNumber } = a as { lot: number; carrier: string; trackingNumber: string };
          const paid = show.claimsFor(lot).find((c) => c.status === "paid");
          const order = paid?.orderId ? show.orders.get(paid.orderId) : undefined;
          if (!paid || !order?.captureId) return { refused: `Lot ${lot} hasn't been paid yet.` };
          return remember({ id: nanoid(10), kind: "track", lot, orderId: order.id, captureId: order.captureId, carrier: carrier.toUpperCase().replace(/[^A-Z_]/g, "_"), trackingNumber, label: `Add ${carrier.toUpperCase()} tracking ${trackingNumber} to lot ${lot} for @${paid.handle}` });
        },
      },
      propose_release: {
        description: "Propose ending an unpaid hold now so the lot goes to the next person in line.",
        parameters: z.object({ lot: z.number().int().positive() }),
        execute: async (a) => {
          const { lot } = a as { lot: number };
          const h = show.claimsFor(lot).find((c) => c.status === "holding");
          if (!h) return { refused: `Nobody is holding lot ${lot} unpaid.` };
          const next = show.waitlist(lot)[0];
          return remember({ id: nanoid(10), kind: "release", lot, handle: h.handle, label: next ? `Move lot ${lot} from @${h.handle} to @${next.handle}` : `Release lot ${lot} from @${h.handle} (nobody waiting)` });
        },
      },
      propose_reminder: {
        description: "Propose sending a buyer who holds an unpaid lot a short reminder in their language.",
        parameters: z.object({ lot: z.number().int().positive() }),
        execute: async (a) => {
          const { lot } = a as { lot: number };
          const h = show.claimsFor(lot).find((c) => c.status === "holding");
          if (!h) return { refused: `Nobody is holding lot ${lot} unpaid.` };
          return remember({ id: nanoid(10), kind: "remind", lot, handle: h.handle, buyerId: h.buyerId, label: `Remind @${h.handle} to pay for lot ${lot}` });
        },
      },
    };
  }

  async ask(show: Show, question: string): Promise<CohostAnswer> {
    const proposals: Proposal[] = [];
    const tools: Record<string, LocalTool> = { ...this.showTools(show, proposals), ...this.readTools };
    const declarations: FunctionDeclaration[] = Object.entries(tools).map(([name, t]) => {
      const schema = zodToJsonSchema(t.parameters, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
      delete schema.$schema;
      return { name, description: t.description.slice(0, 1000), parametersJsonSchema: schema };
    });

    const contents: Content[] = [{ role: "user", parts: [{ text: question }] }];
    const steps: CohostStep[] = [];

    for (let turn = 0; turn < 8; turn++) {
      const res = await this.client.models.generateContent({
        model: this.opts.model,
        contents,
        config: {
          systemInstruction: SYSTEM,
          tools: [{ functionDeclarations: declarations }],
          temperature: 0.1,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });
      const content = res.candidates?.[0]?.content;
      const calls = res.functionCalls ?? [];
      if (!content || calls.length === 0) return { text: res.text?.trim() || "Done.", steps, proposals };

      // keep the model's turn exactly as returned (thought signatures included)
      contents.push(content);
      const responses: Part[] = [];
      for (const call of calls) {
        const name = call.name ?? "";
        const tool = tools[name];
        let result: unknown;
        let ok = false;
        try {
          if (!tool) throw new Error(`Unknown tool ${name}`);
          const args = tool.parameters.parse(call.args ?? {});
          result = await tool.execute(args);
          ok = !(typeof result === "string" && /error|failed/i.test(result)) && !(result && typeof result === "object" && "refused" in result);
        } catch (err) {
          result = { error: (err as Error).message.slice(0, 300) };
        }
        steps.push({ tool: name, args: call.args, ok, result });
        responses.push({ functionResponse: { id: call.id, name, response: { result } } });
      }
      contents.push({ role: "user", parts: responses });
    }
    return { text: "I ran out of steps on that one. Try asking it a simpler way.", steps, proposals };
  }

  /**
   * Runs a proposal the seller confirmed. Everything is re-checked against the show at this
   * moment, because the show keeps moving between the proposal and the tap.
   */
  /**
   * Suggestions the co-host makes on its own while the show runs, from the clock rather than
   * from a question: a reminder when a buyer is about to run out of time, a cheaper relist
   * when a lot comes back with nobody waiting. Same rule as everything else: the seller confirms.
   */
  suggest(
    show: Show,
    s: { kind: "remind"; lot: number; handle: string; buyerId: string } | { kind: "relist"; lot: number; priceCents: number } | { kind: "refund"; lot: number; amountCents: number; captureId: string; handle: string },
  ): Proposal {
    const p: Proposal =
      s.kind === "remind"
        ? { id: nanoid(10), ...s, label: "@" + s.handle + " has 30 seconds left on lot " + s.lot + ". Send a reminder?" }
        : s.kind === "relist"
          ? { id: nanoid(10), ...s, label: "Nobody paid for lot " + s.lot + ". Relist it at " + fmt(s.priceCents) + "?" }
          : { id: nanoid(10), ...s, label: "PayPal confirmed @" + s.handle + "'s payment for lot " + s.lot + " after it had moved on. Refund " + fmt(s.amountCents) + "?" };
    this.proposals.set(p.id, { showId: show.id, p, at: Date.now() });
    return p;
  }

  async confirm(
    show: Show,
    id: string,
    act: {
      release: (lot: number) => void;
      remind: (buyerId: string, lot: number) => Promise<void>;
      relist?: (lot: number, priceCents: number) => void;
      track?: (orderId: string, captureId: string, trackingNumber: string, carrier: string) => Promise<string | undefined>;
      /** Idempotent refund (the request id is derived from the proposal). Falls back to the Agent Toolkit. */
      refund?: (captureId: string, cents: number, requestId: string, note: string) => Promise<{ id?: string; status?: string }>;
    },
  ): Promise<{ ok: boolean; text: string; refundId?: string }> {
    const entry = this.proposals.get(id);
    if (!entry || entry.showId !== show.id) return { ok: false, text: "That proposal has expired." };
    if (this.running.has(id)) return { ok: false, text: "That's already going through." };
    const p = entry.p;
    if (p.kind === "refund") {
      const c = checkRefund(show, p.lot, p.amountCents);
      if (!c.ok) {
        this.proposals.delete(id);
        return { ok: false, text: c.reason };
      }
      this.running.add(id);
      try {
        const note = `Refund for lot ${p.lot}`;
        let res: { id?: string; status?: string };
        if (act.refund) res = await act.refund(c.captureId, p.amountCents, `refund-${p.id}`, note);
        else {
          const raw = await this.createRefund.execute({ capture_id: c.captureId, amount: { value: (p.amountCents / 100).toFixed(2), currency_code: "USD" }, note_to_payer: note });
          res = (typeof raw === "string" ? JSON.parse(raw) : raw) as { id?: string; status?: string };
        }
        if (!res?.id) return { ok: false, text: "PayPal didn't accept the refund." };
        show.recordRefund(c.captureId, p.amountCents, res.id, p.lot);
        this.proposals.delete(id);
        return { ok: true, text: `Refunded ${fmt(p.amountCents)} to @${p.handle} (${res.status ?? "sent"}).`, refundId: res.id };
      } catch (err) {
        // the outcome is unknown: keep the proposal, so Confirm again repeats the same request id
        return { ok: false, text: `PayPal didn't answer (${(err as Error).message.slice(0, 80)}). Press Confirm again; it won't refund twice.` };
      } finally {
        this.running.delete(id);
      }
    }
    this.proposals.delete(id);
    if (p.kind === "release") {
      act.release(p.lot);
      return { ok: true, text: `Lot ${p.lot} moved on from @${p.handle}.` };
    }
    if (p.kind === "track") {
      if (!act.track) return { ok: false, text: "Tracking isn't available on this server." };
      const status = await act.track(p.orderId, p.captureId, p.trackingNumber, p.carrier);
      return { ok: true, text: "Tracking added to lot " + p.lot + (status ? " (" + status + ")" : "") + ". PayPal emails the buyer." };
    }
    if (p.kind === "relist") {
      const lot = show.lots.get(p.lot);
      if (!lot || lot.status !== "open") return { ok: false, text: "Lot " + p.lot + " isn't open any more." };
      act.relist?.(p.lot, p.priceCents);
      return { ok: true, text: "Lot " + p.lot + " is back up at " + fmt(p.priceCents) + "." };
    }
    await act.remind(p.buyerId, p.lot);
    return { ok: true, text: "Reminded @" + p.handle + "." };
  }
}
