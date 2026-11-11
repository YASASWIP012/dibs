import type { ClaimReading } from "./types.js";

/**
 * Keyword fallback for reading chat. It runs when the model is slow, over quota or down,
 * and on every message as a cross-check. It is deliberately conservative: when in doubt,
 * it calls a message chatter so nobody gets charged for a joke.
 */

const CLAIM_WORDS: Array<[RegExp, string]> = [
  [/\b(mine|dibs|sold|claim(ed)?|i'?ll take|take it|i want|want it|yes please)\b/i, "en"],
  [/\b(take|want|grab|need)\b[^?]*\b\d{1,3}\b/i, "en"],
  [/^\s*me+\s*!*\s*(\d{1,3})?\s*!*\s*$/i, "en"],
  [/\b(yo quiero|lo quiero|la quiero|m[ií]o|m[ií]a|me lo llevo|me la llevo|vendido)\b/i, "es"],
  [/\b(je prends|je le prends|je la prends|à moi|pour moi)\b/i, "fr"],
  [/\b(ich nehme|meins|nehm ich)\b/i, "de"],
  [/\b(eu quero|é meu|é minha)\b/i, "pt"],
  [/(मेरा|मेरी|मुझे चाहिए|mera|meri|mujhe chahiye)/i, "hi"],
  [/(私の|ください|欲しい)/, "ja"],
  [/(我要|我的)/, "zh"],
  [/(🙋|✋|🙌|☝️|🖐)/u, "und"],
];

const QUESTION = /(\?|¿|\b(how much|what size|price|size\??|is it|does it|cuánto|talla|combien|wie viel)\b)/i;
const NEGATION = /\b(not mine|no thanks|pass|nope|isn'?t mine|nevermind|never mind|cancel)\b/i;
const LOT_NUMBER = /(?:#|lot\s*|no\.?\s*|number\s*|n[uú]mero\s*)?\b(\d{1,3})\b/gi;
const SIZE = /\b(?:size\s*|talla\s*|taille\s*)?(XXS|XS|S|M|L|XL|XXL|\d{1,2}(?:\.5)?)\b/;

function guessLang(text: string): string {
  if (/[ऀ-ॿ]/.test(text)) return "hi";
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[áéíóúñ¿¡]|\b(quiero|talla|cuánto|el|la)\b/i.test(text)) return "es";
  if (/\b(je|moi|combien|taille)\b/i.test(text)) return "fr";
  if (/\b(ich|meins|wie)\b/i.test(text)) return "de";
  return "en";
}

export function readChatByRules(text: string): ClaimReading {
  const lang = guessLang(text);
  const t = text.trim();
  if (!t || NEGATION.test(t)) return { kind: "chatter", lang, via: "rules" };

  const claimWord = CLAIM_WORDS.find(([re]) => re.test(t));
  const numbers = [...t.matchAll(LOT_NUMBER)]
    .map((m) => Number(m[1]))
    .filter((n) => n > 0 && n < 1000);
  const onlyNumbers = /^[#\s\d,&+and]+$/i.test(t) && numbers.length > 0;

  if (/[?？]\s*$/.test(t) || (QUESTION.test(t) && !claimWord)) return { kind: "question", lang, via: "rules" };

  if (claimWord || onlyNumbers) {
    const sizeMatch = t.replace(LOT_NUMBER, " ").match(SIZE);
    return {
      kind: "claim",
      lotNumbers: [...new Set(numbers)],
      size: sizeMatch?.[1]?.toUpperCase(),
      lang: claimWord?.[1] && claimWord[1] !== "und" ? claimWord[1] : lang,
      confidence: claimWord ? 0.8 : 0.6,
      via: "rules",
    };
  }
  return { kind: "chatter", lang, via: "rules" };
}
