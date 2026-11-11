import { GoogleGenAI, ThinkingLevel, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Show } from "../domain/show.js";

export interface CohostStep {
  tool: string;
  args: unknown;
  ok: boolean;
  result?: unknown;
}

export interface CohostAnswer {
  text: string;
  steps: CohostStep[];
}

interface LocalTool {
  description: string;
  parameters: ZodTypeAny;
  execute: (args: unknown) => Promise<unknown>;
}

const SYSTEM = [
  "You are the co-host for a small reseller running a live sale. Be brief: one to three short sentences, plain words, no markdown.",
  "Always call show_status first. Money amounts are USD.",
  "Only move money (refunds) or add tracking when the seller clearly asks for that exact thing in their latest message. Never refund more than the lot price.",
  "A refund needs the capture id from show_status. Tracking needs the order id and capture id.",
  "If something fails, say what failed in one sentence.",
].join(" ");

/**
 * The seller's co-host. Ask it things in plain words during or after the show
 * ("who hasn't paid?", "refund lot 3"). It reads the show through our own tool and acts on
 * PayPal through the PayPal Agent Toolkit's tools, driven by a Gemini function-calling loop.
 * The loop passes the model's own content back each turn, so newer Gemini models keep their
 * thought signatures across tool calls.
 */
export class Cohost {
  private readonly paypalTools: Record<string, LocalTool>;
  private readonly client: GoogleGenAI;

  constructor(private readonly opts: { clientId: string; clientSecret: string; geminiKey: string; model: string }) {
    const toolkit = new PayPalAgentToolkit({
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
    this.paypalTools = toolkit.getTools() as unknown as Record<string, LocalTool>;
    this.client = new GoogleGenAI({ apiKey: opts.geminiKey, apiVersion: "v1beta" });
  }

  private showTool(show: Show): LocalTool {
    return {
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
    };
  }

  async ask(show: Show, question: string): Promise<CohostAnswer> {
    const tools: Record<string, LocalTool> = { show_status: this.showTool(show), ...this.paypalTools };
    const declarations: FunctionDeclaration[] = Object.entries(tools).map(([name, t]) => {
      const schema = zodToJsonSchema(t.parameters, { target: "openApi3", $refStrategy: "none" }) as Record<string, unknown>;
      delete schema.$schema;
      return { name, description: t.description.slice(0, 1000), parametersJsonSchema: schema };
    });

    const contents: Content[] = [{ role: "user", parts: [{ text: question }] }];
    const steps: CohostStep[] = [];

    for (let turn = 0; turn < 6; turn++) {
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
      if (!content || calls.length === 0) return { text: res.text?.trim() || "Done.", steps };

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
          ok = !(typeof result === "string" && /error|failed/i.test(result));
        } catch (err) {
          result = { error: (err as Error).message.slice(0, 300) };
        }
        steps.push({ tool: name, args: call.args, ok, result });
        responses.push({ functionResponse: { id: call.id, name, response: { result } } });
      }
      contents.push({ role: "user", parts: responses });
    }
    return { text: "I ran out of steps on that one. Try asking it a simpler way.", steps };
  }
}
