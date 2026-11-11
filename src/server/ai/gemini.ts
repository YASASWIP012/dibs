import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import { z } from "zod";
import { readChatByRules } from "../domain/rulesParser.js";
import type { ClaimReading } from "../domain/types.js";

/**
 * Every call here has a deadline and a fallback. A live show can't wait on a model,
 * and a free-tier quota can run out mid-show, so the rules parser always has an answer ready.
 */

const ReadingSchema = z.object({
  kind: z.enum(["claim", "question", "chatter"]),
  lotNumbers: z.array(z.number().int().positive().max(999)).default([]),
  size: z.string().max(8).optional().nullable(),
  lang: z.string().min(2).max(8),
  confidence: z.number().min(0).max(1).default(0.5),
});

const LotSchema = z.object({
  title: z.string().min(2).max(60),
  description: z.string().max(200),
  priceDollars: z.number().nonnegative().max(10_000).nullable(),
  lotNumber: z.number().int().positive().max(999).nullable(),
});

export type LotDraft = { title: string; description: string; priceCents: number | null; number: number | null; via: "model" | "rules" };

export interface AiStats {
  calls: number;
  fallbacks: number;
  cacheHits: number;
  lastError?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))]);
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

/** "lot fourteen, denim jacket, forty bucks" → { number: 14, priceCents: 4000 }. */
export function readLotByRules(spoken: string): LotDraft {
  const words = spoken.toLowerCase().replace(/[$,]/g, " ").split(/\s+/);
  const toNum = (i: number): number | null => {
    const w = words[i];
    if (!w) return null;
    if (/^\d+(\.\d+)?$/.test(w)) return Number(w);
    const a = WORD_NUMBERS[w];
    if (a === undefined) return null;
    const b = WORD_NUMBERS[words[i + 1] ?? ""];
    return b !== undefined && a >= 20 && b < 10 ? a + b : a;
  };
  let number: number | null = null;
  let price: number | null = null;
  for (let i = 0; i < words.length; i++) {
    if (/^(lot|number|item|#)$/.test(words[i]!) && number === null) number = toNum(i + 1);
  }
  for (let i = words.length - 1; i >= 0; i--) {
    let n = toNum(i);
    const tens = WORD_NUMBERS[words[i - 1] ?? ""];
    if (n !== null && n < 10 && tens !== undefined && tens >= 20 && tens % 10 === 0) n = toNum(--i);
    if (n !== null && n !== number) {
      price = n;
      break;
    }
  }
  const title = spoken
    .replace(/\b(lot|number|item)\s+\w+/i, "")
    .replace(/\b(for|at)?\s*\$?\d+(\.\d+)?\s*(bucks|dollars)?\b/gi, "")
    .replace(new RegExp(`\\b(${Object.keys(WORD_NUMBERS).join("|")})\\b`, "gi"), "")
    .replace(/\b(bucks|dollars)\b/gi, "")
    .replace(/[,.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    title: title ? title[0]!.toUpperCase() + title.slice(1, 60) : "New item",
    description: "",
    priceCents: price === null ? null : Math.round(price * 100),
    number,
    via: "rules",
  };
}

export class Ai {
  private readonly client?: GoogleGenAI;
  private readonly cache = new Map<string, unknown>();
  readonly stats: AiStats = { calls: 0, fallbacks: 0, cacheHits: 0 };

  constructor(apiKey: string | undefined, readonly model: string, readonly visionModel: string = model) {
    if (apiKey) this.client = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
  }

  get enabled() {
    return Boolean(this.client);
  }

  private cached<T>(key: string): T | undefined {
    if (this.cache.has(key)) {
      this.stats.cacheHits++;
      return this.cache.get(key) as T;
    }
    return undefined;
  }

  private remember<T>(key: string, value: T): T {
    if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, value);
    return value;
  }

  /** Reads one chat line. The answer only says what the buyer meant; the show decides what happens. */
  async readChat(text: string, ctx: { currentLot?: number; openLots: number[] }): Promise<ClaimReading> {
    const rules = readChatByRules(text);
    if (!this.client) return rules;
    // Clear-cut lines ("mine", "sold 14", "yo quiero 14", a bare number) are decided instantly,
    // so the first person to type always wins regardless of model latency. The model only
    // reads what the rules can't place: slang, other scripts, sarcasm, "not mine".
    if (rules.kind === "claim" && rules.confidence >= 0.8) return rules;
    if (rules.kind === "question" && /\?\s*$/.test(text)) return rules;
    const key = `chat:${ctx.currentLot}:${text.trim().toLowerCase()}`;
    const hit = this.cached<ClaimReading>(key);
    if (hit) return hit;
    try {
      this.stats.calls++;
      const res = await withTimeout(
        this.client.models.generateContent({
          model: this.model,
          contents: `Live sale chat. Lots open right now: ${ctx.openLots.join(", ") || "none"}. The seller is showing lot ${ctx.currentLot ?? "none"}.\nMessage: ${JSON.stringify(text)}`,
          config: {
            systemInstruction:
              "You read chat during a live resale show. Decide if a viewer is claiming an item (wants to buy it), asking a question, or just chatting. Claims can be slang, emoji, or any language: 'mine', 'sold 14', 'yo quiero', 'मेरा', a raised hand. A bare claim with no number means the lot being shown. Jokes, compliments, 'not mine' and questions are not claims. lotNumbers: the lot numbers they claim, empty if none given. lang: ISO 639-1 code of the message. confidence: 0-1.",
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                kind: { type: Type.STRING, enum: ["claim", "question", "chatter"] },
                lotNumbers: { type: Type.ARRAY, items: { type: Type.INTEGER } },
                size: { type: Type.STRING, nullable: true },
                lang: { type: Type.STRING },
                confidence: { type: Type.NUMBER },
              },
              required: ["kind", "lotNumbers", "lang", "confidence"],
            },
            temperature: 0,
            maxOutputTokens: 120,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          },
        }),
        2500,
      );
      const parsed = ReadingSchema.parse(JSON.parse(res.text ?? "{}"));
      const reading: ClaimReading =
        parsed.kind === "claim"
          ? { kind: "claim", lotNumbers: parsed.lotNumbers, size: parsed.size ?? undefined, lang: parsed.lang, confidence: parsed.confidence, via: "model" }
          : { kind: parsed.kind, lang: parsed.lang, via: "model" };
      // When the model and the rules disagree about a claim, trust the safer answer:
      // a low-confidence model claim that the rules call chatter is not charged.
      if (reading.kind === "claim" && rules.kind !== "claim" && parsed.confidence < 0.6) {
        return this.remember(key, { kind: "chatter", lang: parsed.lang, via: "model" } as ClaimReading);
      }
      return this.remember(key, reading);
    } catch (err) {
      this.stats.fallbacks++;
      this.stats.lastError = (err as Error).message.slice(0, 200);
      return rules;
    }
  }

  /** Turns what the seller said plus a camera frame into a listing. The seller can fix it in one tap. */
  async describeLot(spoken: string, frameJpegBase64?: string): Promise<LotDraft> {
    const rules = readLotByRules(spoken);
    if (!this.client) return rules;
    try {
      this.stats.calls++;
      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
        { text: `The seller just said: ${JSON.stringify(spoken)}` },
      ];
      if (frameJpegBase64) parts.push({ inlineData: { mimeType: "image/jpeg", data: frameJpegBase64 } });
      const res = await withTimeout(
        this.client.models.generateContent({
          model: this.visionModel,
          contents: [{ role: "user", parts }],
          config: {
            systemInstruction:
              "You write listings for a small reseller during a live show. Use the seller's words for the price and lot number; never invent a price. Use the photo for the title and an honest one-line description (color, material, visible wear). Title: 2-5 words, no brand unless clearly visible or spoken. Description: one plain sentence, no hype.",
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                description: { type: Type.STRING },
                priceDollars: { type: Type.NUMBER, nullable: true },
                lotNumber: { type: Type.INTEGER, nullable: true },
              },
              required: ["title", "description", "priceDollars", "lotNumber"],
            },
            temperature: 0.2,
            maxOutputTokens: 200,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          },
        }),
        6000,
      );
      const p = LotSchema.parse(JSON.parse(res.text ?? "{}"));
      return {
        title: p.title,
        description: p.description,
        // the spoken number wins over the model's reading of it
        priceCents: rules.priceCents ?? (p.priceDollars === null ? null : Math.round(p.priceDollars * 100)),
        number: rules.number ?? p.lotNumber,
        via: "model",
      };
    } catch (err) {
      this.stats.fallbacks++;
      this.stats.lastError = (err as Error).message.slice(0, 200);
      return rules;
    }
  }

  /** Short replies to buyers in their own language. Falls back to English. */
  async translate(text: string, lang: string): Promise<string> {
    if (!this.client || !lang || lang.startsWith("en") || lang === "und") return text;
    const key = `tr:${lang}:${text}`;
    const hit = this.cached<string>(key);
    if (hit) return hit;
    // Prices, handles, clock times and lot numbers are swapped for placeholders before the model
    // sees the text and put back afterwards, so a translation can never change an amount.
    const kept: string[] = [];
    const masked = text.replace(/\$\d+(?:\.\d{2})?|@[\w.-]+|\b\d+:\d{2}\b|\b\d+\b/g, (m) => `[[${kept.push(m) - 1}]]`);
    try {
      this.stats.calls++;
      const res = await withTimeout(
        this.client.models.generateContent({
          model: this.model,
          contents: masked,
          config: {
            systemInstruction: `Translate this short message for a live-sale viewer into the language with ISO code "${lang}". Copy every [[n]] placeholder exactly once, unchanged. Casual tone. Output only the translation.`,
            temperature: 0,
            maxOutputTokens: 200,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          },
        }),
        4500,
      );
      let out = res.text?.trim() ?? "";
      // every placeholder must come back exactly once, or we keep the English
      const ok = kept.every((_, i) => out.split(`[[${i}]]`).length === 2);
      if (!out || !ok) return text;
      out = out.replace(/\[\[(\d+)\]\]/g, (_, i) => kept[Number(i)] ?? "");
      return this.remember(key, out);
    } catch (err) {
      this.stats.fallbacks++;
      this.stats.lastError = (err as Error).message.slice(0, 200);
      return text;
    }
  }
}
