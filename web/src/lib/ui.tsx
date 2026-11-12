import { useEffect, useRef, useState } from "react";
import type { Claim, Lot, Snapshot } from "./api";
import { api, ApiError, clock, money } from "./api";

export function Logo({ size = 28 }: { size?: number }) {
  return <img src="/icon.svg" width={size} height={size} alt="" className="app-icon" style={{ width: size, height: size }} />;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** "1 minute 20 seconds left to pay", for screen readers. */
export function spokenTime(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m ? plural(m, "minute") + (s ? " " : "") : ""}${s || !m ? plural(s, "second") : ""} left to pay`;
}

export function Countdown({ claim, now, holdMs }: { claim: Claim; now: number; holdMs: number }) {
  if (claim.status === "paid") return <span className="ring is-paid" aria-label="Paid" />;
  const left = Math.max(0, (claim.deadline ?? now) - now);
  const p = holdMs ? left / holdMs : 0;
  return (
    <>
      <span className={`ring${p < 0.25 ? " is-low" : ""}`} style={{ "--p": p } as React.CSSProperties} aria-hidden="true" />
      <span className="t-mono" role="timer" aria-label={spokenTime(left)}>
        {clock(left)}
      </span>
    </>
  );
}

export function StatusPill({ lot }: { lot: Lot }) {
  const label = { open: "Open", held: "Held", sold: "Paid", unsold: "Unsold" }[lot.status];
  return <span className={`pill pill--${lot.status === "sold" ? "sold" : lot.status === "held" ? "held" : "open"}`}>{label}</span>;
}

export function LotCard({ lot, show, now, fresh }: { lot: Lot; show: Snapshot; now: number; fresh?: boolean }) {
  const claims = show.claims.filter((c) => c.lotNumber === lot.number).sort((a, b) => a.receivedAt - b.receivedAt);
  const holder = claims.find((c) => c.status === "holding" || c.status === "paid");
  const waiting = claims.filter((c) => c.status === "waiting");
  const lapsed = claims.filter((c) => c.status === "lapsed");
  return (
    <article className="lot" aria-label={`Lot ${lot.number}, ${lot.title}`}>
      {fresh ? <span className="lot__flash" aria-hidden="true" /> : null}
      <div className="lot__img">{lot.photo ? <img src={lot.photo} alt={lot.title} /> : <span>{lot.number}</span>}</div>
      <span className="lot__num">#{lot.number}</span>
      <span className="lot__status">
        <StatusPill lot={lot} />
      </span>
      <div className="lot__body">
        <div className="lot__title">
          <span>{lot.title}</span>
          <span className="lot__price">{money(lot.price.cents)}</span>
        </div>
        {lot.description && <p className="lot__desc">{lot.description}</p>}
        {holder ? (
          <div className="holder">
            <Countdown claim={holder} now={now} holdMs={show.holdMs} />
            <span className="who">@{holder.handle}</span>
            {holder.status === "paid" && <span className="pill pill--sold">Paid</span>}
          </div>
        ) : (
          <p className="hint">No claims yet</p>
        )}
        {(waiting.length > 0 || lapsed.length > 0) && (
          <div className="queue" aria-label="Line">
            {lapsed.map((c) => (
              <span key={c.id} className="pill pill--lapsed" title="Didn't pay in time">
                @{c.handle}
              </span>
            ))}
            {waiting.map((c, i) => (
              <span key={c.id} className="chip chip--soft">
                {i + 1}. @{c.handle}
              </span>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

// ---------- PayPal buttons ----------

declare global {
  interface Window {
    paypal?: {
      Buttons: (opts: Record<string, unknown>) => { render: (el: HTMLElement) => Promise<void>; close: () => Promise<void>; isEligible: () => boolean };
      FUNDING: Record<string, string>;
    };
  }
}

let sdkPromise: Promise<void> | null = null;
function loadPayPal(clientId: string) {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    const q = new URLSearchParams({ "client-id": clientId, currency: "USD", intent: "capture", components: "buttons", "enable-funding": "venmo,paylater" });
    s.src = `https://www.paypal.com/sdk/js?${q}`;
    s.dataset.namespace = "paypal";
    s.onload = () => resolve();
    s.onerror = () => {
      sdkPromise = null;
      reject(new Error("PayPal didn't load"));
    };
    document.head.appendChild(s);
  });
  return sdkPromise;
}

/**
 * PayPal checkout for everything this buyer holds. The order is created on our server at click
 * time, so the total always matches what they hold right now; capture is refused on the server
 * if a hold ran out while the PayPal window was open.
 */
export function PayButtons({ showId, token, holdingKey, onPaid, onError }: { showId: string; token: string; holdingKey: string; onPaid: () => void; onError: (m: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "off">("loading");
  const cb = useRef({ onPaid, onError });
  cb.current = { onPaid, onError };

  useEffect(() => {
    let buttons: ReturnType<NonNullable<Window["paypal"]>["Buttons"]> | null = null;
    let cancelled = false;
    (async () => {
      const cfg = await api<{ paypalClientId: string | null }>("/api/config");
      if (!cfg.paypalClientId) return setState("off");
      await loadPayPal(cfg.paypalClientId);
      if (cancelled || !ref.current || !window.paypal) return;
      ref.current.innerHTML = "";
      buttons = window.paypal.Buttons({
        style: { layout: "vertical", shape: "pill", label: "pay", height: 46 },
        createOrder: async () => (await api<{ orderId: string }>(`/api/shows/${showId}/checkout`, { token })).orderId,
        onApprove: async (data: { orderID: string }) => {
          try {
            const res = await api<{ order?: { status?: string } }>(`/api/shows/${showId}/capture`, { token, orderId: data.orderID });
            // PENDING (e.g. a bank payment) stays reserved until PayPal's webhook says it cleared
            if (res.order?.status && res.order.status !== "captured") cb.current.onError("PayPal is still processing your payment. The item stays yours until it clears.");
            else cb.current.onPaid();
          } catch (e) {
            cb.current.onError(e instanceof ApiError && e.status === 409 ? "Time ran out while you were paying, so the item went to the next person. You were not charged." : (e as Error).message);
          }
        },
        onError: () => cb.current.onError("PayPal had a problem. Try again in a moment."),
      });
      await buttons.render(ref.current);
      setState("ready");
    })().catch(() => setState("off"));
    return () => {
      cancelled = true;
      buttons?.close().catch(() => undefined);
    };
  }, [showId, token, holdingKey]);

  return (
    <div>
      {state === "loading" && <p className="hint">Loading PayPal…</p>}
      {state === "off" && <p className="hint">Checkout isn't connected on this server.</p>}
      <div ref={ref} />
    </div>
  );
}
