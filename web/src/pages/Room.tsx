import { useEffect, useMemo, useRef, useState } from "react";
import { api, LANGS, money, type Buyer } from "../lib/api";
import { useShow } from "../lib/useShow";
import { Countdown, Logo, PayButtons } from "../lib/ui";

function savedBuyer(showId: string): Buyer | null {
  try {
    return JSON.parse(localStorage.getItem(`dibs:buyer:${showId}`) ?? "null");
  } catch {
    return null;
  }
}

export function Room({ showId, embedded }: { showId: string; embedded?: boolean }) {
  const [buyer, setBuyer] = useState<Buyer | null>(() => savedBuyer(showId));
  const live = useShow(showId, "buyer", { buyerId: buyer?.id });
  const { show, now, frameUrl, caption } = live;
  const [text, setText] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [show?.chat.length]);

  const current = useMemo(() => {
    if (!show) return undefined;
    return [...show.lots].sort((a, b) => b.createdAt - a.createdAt)[0];
  }, [show]);

  const mine = useMemo(() => (show && buyer ? show.claims.filter((c) => c.buyerId === buyer.id && c.status !== "lapsed") : []), [show, buyer]);
  const holding = mine.filter((c) => c.status === "holding");
  const holdingKey = holding.map((c) => c.id).sort().join(",");
  const holdingTotal = holding.reduce((s, c) => s + (show?.lots.find((l) => l.number === c.lotNumber)?.price.cents ?? 0), 0);

  const send = async (msg: string) => {
    if (!buyer || !msg.trim()) return;
    setText("");
    await api(`/api/shows/${showId}/chat`, { buyerId: buyer.id, text: msg }).catch((e) => setToast(e.message));
  };

  if (!show) {
    return (
      <div className="room">
        <div className="cam">
          <div className="empty">{live.connected ? "Loading the show…" : "Connecting…"}</div>
        </div>
      </div>
    );
  }

  const visibleChat = show.chat.filter((m) => !m.system || m.buyerId === buyer?.id).slice(-40);

  return (
    <div className="room" style={embedded ? { minHeight: "100%" } : undefined}>
      <div className="cam" aria-label="Live video from the seller">
        {frameUrl ? <img src={frameUrl} alt="Seller's live camera" /> : <div className="empty">Waiting for the seller's camera</div>}
        <div className="overlay-top">
          <span className="pill pill--live">Live</span>
          <span className="pill" style={{ background: "rgba(5,12,32,.55)", color: "#fff" }}>
            {show.lots.filter((l) => l.status === "sold").length} sold
          </span>
        </div>
        {caption && <div className="caption" aria-live="polite">{caption}</div>}
      </div>

      <div className="room-sheet">
        {current && (
          <div className="now-lot">
            {current.photo ? <img src={current.photo} alt="" /> : <div className="ph" />}
            <div className="grow">
              <div className="t-small" style={{ color: "var(--ink-3)" }}>
                Lot {current.number} · {current.status === "sold" ? "sold" : current.status === "held" ? "held" : "open"}
              </div>
              <div style={{ fontWeight: 600, fontSize: 16 }}>{current.title}</div>
              <div className="t-mono">{money(current.price.cents)}</div>
            </div>
            {buyer && current.status !== "sold" && (
              <button className="btn btn-candy dibs-btn" onClick={() => send(`dibs ${current.number}`)} aria-label={`Claim lot ${current.number}`}>
                Dibs
              </button>
            )}
          </div>
        )}

        {!buyer ? (
          <JoinForm showId={showId} onJoined={(b) => { setBuyer(b); localStorage.setItem(`dibs:buyer:${showId}`, JSON.stringify(b)); }} />
        ) : (
          <>
            {mine.length > 0 && (
              <div className="mine" aria-label="Your items">
                {mine.map((c) => {
                  const lot = show.lots.find((l) => l.number === c.lotNumber);
                  const pos = show.claims.filter((x) => x.lotNumber === c.lotNumber && x.status === "waiting").sort((a, b) => a.receivedAt - b.receivedAt).findIndex((x) => x.id === c.id) + 1;
                  return (
                    <div key={c.id} className={`holder${c.status === "waiting" ? " is-wait" : c.status === "paid" ? " is-paid" : ""}`}>
                      {c.status === "waiting" ? <span className="pill pill--held">#{pos} in line</span> : <Countdown claim={c} now={now} holdMs={show.holdMs} />}
                      <span className="grow">
                        <b>Lot {c.lotNumber}</b> {lot?.title}
                      </span>
                      <span className="t-mono">{money(lot?.price.cents ?? 0)}</span>
                    </div>
                  );
                })}
              </div>
            )}
            {holding.length > 0 && (
              <div className="paybox">
                <div className="row" style={{ marginBottom: 10 }}>
                  <b className="grow">Pay for {holding.length === 1 ? "your item" : `${holding.length} items`}</b>
                  <span className="t-mono">{money(holdingTotal)}</span>
                </div>
                <PayButtons showId={showId} buyerId={buyer.id} holdingKey={holdingKey} onPaid={() => setToast("Paid. The seller has it.")} onError={setToast} />
              </div>
            )}

            <div className="chat" ref={chatRef} aria-live="polite" style={{ maxHeight: 260, padding: "0 2px" }}>
              {visibleChat.map((m) => (
                <div key={m.id} className={`msg${m.system ? (m.handle === "paypal" ? " msg--paypal" : " msg--system") : ""}`}>
                  <p className="msg__line">
                    <span className="msg__who">{m.system ? (m.handle === "paypal" ? "PayPal" : "Dibs") : `@${m.handle}`}</span>
                    {m.text}
                  </p>
                </div>
              ))}
            </div>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void send(text);
              }}
            >
              <input className="input grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type “mine”, a lot number, or ask something" aria-label="Chat message" maxLength={280} />
              <button className="btn btn-ink btn-sm" type="submit">Send</button>
            </form>
          </>
        )}
        <p className="t-micro" style={{ textAlign: "center", padding: "6px 0 2px" }}>
          <Logo size={14} /> Payments by PayPal sandbox · No real money moves
        </p>
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function JoinForm({ showId, onJoined }: { showId: string; onJoined: (b: Buyer) => void }) {
  const [handle, setHandle] = useState("");
  const [lang, setLang] = useState(() => (navigator.language || "en").slice(0, 2));
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="card"
      style={{ display: "grid", gap: 12 }}
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const { buyer } = await api<{ buyer: Buyer }>(`/api/shows/${showId}/join`, { handle, lang });
          onJoined(buyer);
        } catch (e) {
          setErr((e as Error).message);
        }
      }}
    >
      <b style={{ fontSize: 17 }}>Join the show</b>
      <label className="field">
        Your name in chat
        <input className="input" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="maria" required maxLength={24} autoFocus />
      </label>
      <label className="field">
        Replies in
        <select className="input" value={lang} onChange={(e) => setLang(e.target.value)}>
          {LANGS.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {err && <p className="hint" style={{ color: "var(--live)" }}>{err}</p>}
      <button className="btn btn-candy" type="submit">Join</button>
    </form>
  );
}
