import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import { generateText, tool, type CoreMessage } from "ai";
import { z } from "zod";
import type { Show } from "../domain/show.js";

export interface CohostStep {
  tool: string;
  args: unknown;
  ok: boolean;
}

export interface CohostAnswer {
  text: string;
  steps: CohostStep[];
}

/**
 * The seller's co-host. Ask it things in plain words during or after the show
 * ("who hasn't paid?", "refund lot 3", "add tracking 9400... for maria"). It reads the show
 * through our own tool and acts on PayPal through the PayPal Agent Toolkit.
 */
export class Cohost {
  private readonly toolkit: PayPalAgentToolkit;
  private readonly google: ReturnType<typeof createGoogleGenerativeAI>;

  constructor(
    private readonly opts: { clientId: string; clientSecret: string; geminiKey: string; model: string },
  ) {
    this.toolkit = new PayPalAgentToolkit({
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      configuration: {
        actions: {
          orders: { get: true },
          payments: { createRefund: true, getRefunds: true },
          transactions: { list: true },
          shipment: { create: true, get: true },
        },
        context: { sandbox: true },
      },
    });
    this.google = createGoogleGenerativeAI({ apiKey: opts.geminiKey });
  }

  async ask(show: Show, question: string, history: CoreMessage[] = []): Promise<CohostAnswer> {
    const steps: CohostStep[] = [];
    const showStatus = tool({
      description:
        "Current state of this live show: every lot with its price and status, who holds or paid for it, who is waiting, PayPal order ids and capture ids. Call this before answering anything about the show or before acting on a payment.",
      parameters: z.object({}),
      execute: async () => {
        const snap = show.snapshot();
        return {
          lots: snap.lots.map((l) => ({
            lot: l.number,
            title: l.title,
            price: (l.price.cents / 100).toFixed(2),
            status: l.status,
            claims: show.claimsFor(l.number).map((c) => ({
              handle: c.handle,
              status: c.status,
              secondsLeft: c.status === "holding" && c.deadline ? Math.max(0, Math.round((c.deadline - snap.serverNow) / 1000)) : undefined,
              orderId: c.orderId,
              captureId: c.orderId ? show.orders.get(c.orderId)?.captureId : undefined,
            })),
          })),
          recap: snap.recap,
        };
      },
    });

    const paypalTools = this.toolkit.getTools();
    const res = await generateText({
      model: this.google(this.opts.model),
      system: [
        "You are the co-host for a small reseller running a live sale. Be brief: one to three short sentences, plain words, no markdown headings.",
        "Always call show_status first. Money amounts are USD.",
        "Only move money (refunds) or add tracking when the seller clearly asks for that exact thing in their latest message. Never refund more than the lot price.",
        "A refund needs the capture id from show_status. Tracking needs the order id and capture id.",
        "If something fails, say what failed in one sentence.",
      ].join(" "),
      messages: [...history.slice(-8), { role: "user", content: question }],
      tools: { show_status: showStatus, ...paypalTools },
      maxSteps: 6,
      temperature: 0.1,
      onStepFinish: (step) => {
        for (const call of step.toolCalls) {
          const result = step.toolResults.find((r) => r.toolCallId === call.toolCallId);
          steps.push({ tool: call.toolName, args: call.args, ok: result !== undefined && !/error/i.test(JSON.stringify(result.result ?? "")) });
        }
      },
    });
    return { text: res.text.trim() || "Done.", steps };
  }
}
