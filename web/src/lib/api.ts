import type { Buyer, ChatMessage, Claim, Lot, PendingOrder, ShowEvent } from "../../../src/server/domain/types";

export type { Buyer, ChatMessage, Claim, Lot, PendingOrder, ShowEvent };

export interface Recap {
  lots: number;
  sold: number;
  soldCents: number;
  unsold: number;
  lapsedClaims: number;
  rescuedLots: number;
  rescuedCents: number;
  buyers: number;
}

export interface Snapshot {
  id: string;
  holdMs: number;
  lots: Lot[];
  claims: Claim[];
  buyers: Buyer[];
  orders: PendingOrder[];
  chat: ChatMessage[];
  recap: Recap;
  serverNow: number;
  viewers?: number;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error ?? "error", json.message ?? "Something went wrong");
  return json as T;
}

export const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

export function clock(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const LANGS: Array<[string, string]> = [
  ["en", "English"],
  ["es", "Español"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["pt", "Português"],
  ["hi", "हिन्दी"],
  ["ja", "日本語"],
  ["zh", "中文"],
];
