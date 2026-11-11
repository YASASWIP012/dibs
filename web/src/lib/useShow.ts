import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ShowEvent, Snapshot } from "./api";

type Action = { type: "snapshot"; show: Snapshot } | { type: "event"; event: ShowEvent };

function upsert<T>(list: T[], item: T, key: (t: T) => string | number): T[] {
  const k = key(item);
  const i = list.findIndex((x) => key(x) === k);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function reduce(state: Snapshot | null, action: Action): Snapshot | null {
  if (action.type === "snapshot") return action.show;
  if (!state) return state;
  const e = action.event;
  switch (e.type) {
    case "lot.opened":
    case "lot.updated":
      return { ...state, lots: upsert(state.lots, e.lot, (l) => l.number) };
    case "claim.created":
    case "claim.holding":
    case "claim.paid":
      return { ...state, claims: upsert(state.claims, { ...e.claim }, (c) => c.id) };
    case "claim.lapsed": {
      let claims = upsert(state.claims, { ...e.claim }, (c) => c.id);
      if (e.next) claims = upsert(claims, { ...e.next }, (c) => c.id);
      return { ...state, claims };
    }
    case "order.created":
    case "order.captured":
      return { ...state, orders: upsert(state.orders, e.order, (o) => o.id) };
    case "chat":
      return { ...state, chat: [...state.chat, e.message].slice(-200) };
    default:
      return state;
  }
}

export interface Live {
  show: Snapshot | null;
  connected: boolean;
  /** Server time, so countdowns agree between the studio and every phone. */
  now: number;
  caption: string;
  frameUrl: string | null;
  lastEvent: ShowEvent | null;
  socket: React.MutableRefObject<WebSocket | null>;
  webhooks: Array<{ text: string; at: number }>;
}

export function useShow(showId: string | undefined, role: "seller" | "buyer" | "watch", opts: { sellerKey?: string; buyerId?: string } = {}): Live {
  const [show, dispatch] = useReducer(reduce, null);
  const [connected, setConnected] = useState(false);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [caption, setCaption] = useState("");
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<ShowEvent | null>(null);
  const [webhooks, setWebhooks] = useState<Array<{ text: string; at: number }>>([]);
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + offset), 250);
    return () => clearInterval(t);
  }, [offset]);

  useEffect(() => {
    if (!showId) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    let lastUrl: string | null = null;
    const connect = () => {
      const q = new URLSearchParams({ role });
      if (opts.sellerKey) q.set("key", opts.sellerKey);
      if (opts.buyerId) q.set("buyer", opts.buyerId);
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${showId}?${q}`);
      ws.binaryType = "blob";
      socket.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1200);
      };
      ws.onmessage = (m) => {
        if (m.data instanceof Blob) {
          const url = URL.createObjectURL(m.data);
          setFrameUrl(url);
          if (lastUrl) setTimeout(((u) => () => URL.revokeObjectURL(u))(lastUrl), 1000);
          lastUrl = url;
          return;
        }
        const msg = JSON.parse(m.data as string);
        if (msg.type === "snapshot") {
          setOffset(msg.show.serverNow - Date.now());
          dispatch({ type: "snapshot", show: msg.show });
        } else if (msg.type === "event") {
          if (typeof msg.serverNow === "number") setOffset(msg.serverNow - Date.now());
          const e = msg.event as ShowEvent;
          if (e.type === "caption") setCaption(e.text);
          if (e.type === "chat" && e.message.handle === "paypal") setWebhooks((w) => [{ text: e.message.text, at: e.message.at }, ...w].slice(0, 12));
          setLastEvent(e);
          dispatch({ type: "event", event: e });
        }
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket.current?.close();
    };
  }, [showId, role, opts.sellerKey, opts.buyerId]);

  return useMemo(
    () => ({ show, connected, now, caption, frameUrl, lastEvent, socket, webhooks }),
    [show, connected, now, caption, frameUrl, lastEvent, webhooks],
  );
}
