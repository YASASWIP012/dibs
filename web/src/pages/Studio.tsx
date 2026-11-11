import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { api, money, type Lot } from "../lib/api";
import { useShow } from "../lib/useShow";
import { LotCard, Logo } from "../lib/ui";

interface Session {
  showId: string;
  sellerKey: string;
}

type SpeechRec = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

/** Looks like the seller is calling a new item: "lot 4 ...", or an item name plus a price. */
export function soundsLikeLot(t: string) {
  return /\b(lot|number|item)\s+(\d+|[a-z]+)\b/i.test(t) && /\b(\d+|ten|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b.*\b(bucks|dollars|\d+)?/i.test(t);
}

export function Studio() {
  const [session, setSession] = useState<Session | null>(() => {
    try {
      return JSON.parse(localStorage.getItem("dibs:studio") ?? "null");
    } catch {
      return null;
    }
  });
  const live = useShow(session?.showId, "seller", { sellerKey: session?.sellerKey });
  const { show, now, caption, socket } = live;

  // the show may be gone after a server restart: start over cleanly
  useEffect(() => {
    if (!session) return;
    api(`/api/shows/${session.showId}`).catch(() => {
      localStorage.removeItem("dibs:studio");
      setSession(null);
    });
  }, [session]);

  const start = async (holdSeconds: number) => {
    const s = await api<Session>("/api/shows", { holdSeconds });
    localStorage.setItem("dibs:studio", JSON.stringify(s));
    setSession(s);
  };

  if (!session) return <StartShow onStart={start} />;

  return (
    <div className="app">
      <header className="app-top">
        <a className="brand" href="/">
          <Logo /> Dibs
        </a>
        <span className="pill pill--live">Live</span>
        <span className="code" title="Show code">{session.showId}</span>
        <span className="hint">{show?.viewers ?? 0} watching</span>
        <span className="spacer" />
        <ShareLink showId={session.showId} />
        <button
          className="btn btn-outline btn-sm"
          onClick={() => {
            if (!confirm("End this show and start a new one?")) return;
            localStorage.removeItem("dibs:studio");
            setSession(null);
          }}
        >
          New show
        </button>
      </header>
      <main className="studio">
        <div className="col-left">
          <Camera session={session} socket={socket} caption={caption} />
          <LotComposer session={session} nextNumber={(show?.lots.reduce((m, l) => Math.max(m, l.number), 0) ?? 0) + 1} />
        </div>
        <div className="col-mid">
          <Recap show={show} />
          <section className="panel-card" style={{ marginTop: 16 }}>
            <div className="panel-head">
              Claim board <span className="spacer" />
              <span className="t-micro" style={{ textTransform: "none", letterSpacing: 0 }}>
                {Math.round((show?.holdMs ?? 0) / 1000)}s to pay, then it goes to the next person
              </span>
            </div>
            <div className="panel-body">
              {show && show.lots.length > 0 ? (
                <div className="board">
                  {[...show.lots]
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .map((lot) => (
                      <LotCard key={lot.number} lot={lot} show={show} now={now} fresh={now - lot.createdAt < 4000} />
                    ))}
                </div>
              ) : (
                <p className="hint" style={{ padding: "24px 0" }}>
                  Hold an item up and say something like <b>“lot one, denim jacket, forty”</b>. It shows up here and on every buyer's phone.
                </p>
              )}
            </div>
          </section>
        </div>
        <div className="col-right">
          <ChatPanel show={show} />
          <Cohost session={session} webhooks={live.webhooks} />
        </div>
      </main>
    </div>
  );
}

function StartShow({ onStart }: { onStart: (holdSeconds: number) => void }) {
  const [hold, setHold] = useState(120);
  return (
    <div className="app" style={{ display: "grid", placeItems: "center", padding: 24 }}>
      <div className="card card--raised" style={{ maxWidth: 440, width: "100%", display: "grid", gap: 16, padding: 28 }}>
        <a href="/" className="row" style={{ gap: 10, fontWeight: 600, fontSize: 18 }}>
          <Logo /> Dibs
        </a>
        <h1 className="t-h3">Go live.</h1>
        <p className="t-small">You'll get a link for buyers. They claim in chat, pay with PayPal, and anything unpaid moves to the next person in line on its own.</p>
        <div className="field">
          Time to pay before an item moves on
          <div className="segmented" role="group" aria-label="Time to pay">
            {[60, 120, 300].map((s) => (
              <button key={s} aria-pressed={hold === s} onClick={() => setHold(s)}>
                {s / 60} min
              </button>
            ))}
          </div>
        </div>
        <button className="btn btn-candy btn-lg" onClick={() => onStart(hold)}>
          Start a show
        </button>
        <p className="t-micro">Runs on the PayPal sandbox. No real money moves.</p>
      </div>
    </div>
  );
}

function ShareLink({ showId }: { showId: string }) {
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState<string>("");
  const url = `${location.origin}/s/${showId}`;
  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 220, color: { dark: "#0B1F4D", light: "#ffffff" } }).then(setQr);
  }, [url]);
  return (
    <div style={{ position: "relative" }}>
      <button className="btn btn-ink btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Buyer link
      </button>
      {open && (
        <div className="card card--raised" style={{ position: "absolute", right: 0, top: 44, width: 260, display: "grid", gap: 10, zIndex: 30 }}>
          {qr && <img src={qr} alt="QR code for the buyer link" width={220} height={220} style={{ margin: "0 auto" }} />}
          <input className="input t-mono" readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Buyer link" />
          <button className="btn btn-outline btn-sm" onClick={() => navigator.clipboard.writeText(url)}>
            Copy link
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- camera + voice ----------

function Camera({ session, socket, caption }: { session: Session; socket: React.MutableRefObject<WebSocket | null>; caption: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const [camOn, setCamOn] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<SpeechRec | null>(null);
  const wantListen = useRef(false);
  const lastCall = useRef(0);

  const grab = useCallback((width = 640, quality = 0.62): string | undefined => {
    const v = video.current;
    if (!v || !v.videoWidth) return undefined;
    const c = canvas.current;
    c.width = width;
    c.height = Math.round((v.videoHeight / v.videoWidth) * width);
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", quality);
  }, []);

  // stream frames to buyers: small JPEGs over the socket, about 5 per second
  useEffect(() => {
    if (!camOn) return;
    const t = setInterval(() => {
      const ws = socket.current;
      const v = video.current;
      if (!ws || ws.readyState !== 1 || !v?.videoWidth || ws.bufferedAmount > 500_000) return;
      const c = canvas.current;
      c.width = 480;
      c.height = Math.round((v.videoHeight / v.videoWidth) * 480);
      c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
      c.toBlob((b) => b && ws.readyState === 1 && ws.send(b), "image/jpeg", 0.55);
    }, 200);
    return () => clearInterval(t);
  }, [camOn, socket]);

  const startCam = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 960, facingMode: "user" }, audio: false });
      if (video.current) {
        video.current.srcObject = stream;
        await video.current.play();
      }
      setCamOn(true);
      setError(null);
    } catch {
      setError("Camera blocked. Allow camera access in the address bar, then try again.");
    }
  };

  const callLot = useCallback(
    async (spoken: string) => {
      if (Date.now() - lastCall.current < 2500) return;
      lastCall.current = Date.now();
      await api(`/api/shows/${session.showId}/lots`, { spoken, frame: grab() }, { "x-seller-key": session.sellerKey }).catch((e) => setError(e.message));
    },
    [grab, session],
  );

  const toggleVoice = () => {
    const Ctor = (window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec }).webkitSpeechRecognition;
    if (!Ctor) return setError("Voice needs Chrome or Edge. You can still type lots below.");
    if (wantListen.current) {
      wantListen.current = false;
      rec.current?.stop();
      setListening(false);
      return;
    }
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    r.onresult = (e) => {
      let finalText = "";
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) finalText += res[0].transcript;
        else interimText += res[0].transcript;
      }
      setInterim(interimText);
      if (finalText.trim()) {
        void api(`/api/shows/${session.showId}/caption`, { text: finalText.trim() }, { "x-seller-key": session.sellerKey }).catch(() => undefined);
        if (soundsLikeLot(finalText)) void callLot(finalText.trim());
      }
    };
    // Chrome stops listening after a pause; keep going until the seller turns it off
    r.onend = () => {
      if (wantListen.current) r.start();
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed") {
        wantListen.current = false;
        setListening(false);
        setError("Microphone blocked. Allow it in the address bar.");
      }
    };
    rec.current = r;
    wantListen.current = true;
    r.start();
    setListening(true);
  };

  useEffect(() => () => {
    wantListen.current = false;
    rec.current?.stop();
  }, []);

  return (
    <section className="panel-card">
      <div className="panel-head">
        Camera <span className="spacer" />
        {listening && <span className="pill pill--live">Listening</span>}
      </div>
      <div className="panel-body" style={{ display: "grid", gap: 10 }}>
        <div className="cam">
          <video ref={video} muted playsInline aria-label="Your camera" />
          {!camOn && <div className="empty">Your camera stays on this screen and streams to buyers as you sell.</div>}
          {(interim || caption) && <div className="caption">{interim || caption}</div>}
        </div>
        <div className="row">
          <button className={`btn btn-sm ${camOn ? "btn-outline" : "btn-candy"}`} onClick={startCam} disabled={camOn}>
            {camOn ? "Camera on" : "Turn on camera"}
          </button>
          <button className={`btn btn-sm ${listening ? "btn-ink" : "btn-outline"}`} onClick={toggleVoice}>
            {listening ? "Stop listening" : "Listen for lots"}
          </button>
        </div>
        <p className="hint">Say “lot three, snake plant, twenty five”. Dibs writes the listing from what you say and what the camera sees.</p>
        {error && <p className="hint" style={{ color: "var(--live)" }}>{error}</p>}
      </div>
    </section>
  );
}

function LotComposer({ session, nextNumber }: { session: Session; nextNumber: number }) {
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <section className="panel-card">
      <div className="panel-head">Add a lot by hand</div>
      <form
        className="panel-body"
        style={{ display: "grid", gap: 10 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const cents = Math.round(Number(price) * 100);
          await api(`/api/shows/${session.showId}/lots`, { title, priceCents: Number.isFinite(cents) ? cents : 0, number: nextNumber }, { "x-seller-key": session.sellerKey }).finally(() => setBusy(false));
          setTitle("");
          setPrice("");
        }}
      >
        <div className="row">
          <span className="code t-mono">#{nextNumber}</span>
          <input className="input grow" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Item" required maxLength={60} aria-label="Item name" />
          <input className="input" style={{ width: 90 }} value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))} placeholder="$" required inputMode="decimal" aria-label="Price in dollars" />
        </div>
        <button className="btn btn-outline btn-sm" disabled={busy}>
          Put it up
        </button>
      </form>
    </section>
  );
}

export function ChatPanel({ show }: { show: ReturnType<typeof useShow>["show"] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [show?.chat.length]);
  const lines = (show?.chat ?? []).slice(-80);
  return (
    <section className="panel-card">
      <div className="panel-head">Chat, as Dibs reads it</div>
      <div className="chat" ref={ref} aria-live="polite">
        {lines.length === 0 && <p className="hint">Buyers' messages show up here with how each one was understood.</p>}
        {lines.map((m) => (
          <div key={m.id} className={`msg${m.system ? (m.handle === "paypal" ? " msg--paypal" : " msg--system") : ""}`}>
            <p className="msg__line">
              <span className="msg__who">{m.system ? (m.handle === "paypal" ? "PayPal webhook" : "Dibs →") : `@${m.handle}`}</span>
              {m.text}
            </p>
            {m.reading && (
              <div className="msg__meta">
                <span className={`pill ${m.reading.kind === "claim" ? "pill--held" : "pill--open"}`}>
                  {m.reading.kind === "claim" ? `claim ${m.reading.lotNumbers.length ? m.reading.lotNumbers.map((n) => `#${n}`).join(" ") : "current lot"}` : m.reading.kind}
                </span>
                <span className="pill pill--rules">{m.reading.lang}</span>
                <span className={`pill ${m.reading.via === "model" ? "pill--model" : "pill--rules"}`}>{m.reading.via === "model" ? "read by Gemini" : "keyword rules"}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function Recap({ show }: { show: ReturnType<typeof useShow>["show"] }) {
  const r = useMemo(() => {
    const lots = show?.lots ?? [];
    const claims = show?.claims ?? [];
    const sold = lots.filter((l) => l.status === "sold");
    const rescued = sold.filter((l: Lot) => claims.some((c) => c.lotNumber === l.number && c.status === "lapsed"));
    return {
      soldCents: sold.reduce((s, l) => s + l.price.cents, 0),
      sold: sold.length,
      lots: lots.length,
      rescuedCents: rescued.reduce((s, l) => s + l.price.cents, 0),
      rescued: rescued.length,
      waiting: claims.filter((c) => c.status === "holding").length,
    };
  }, [show]);
  return (
    <div className="stats">
      <div className="stat is-accent">
        <b className="t-mono">{money(r.soldCents)}</b>
        <span>paid through PayPal</span>
      </div>
      <div className="stat">
        <b>
          {r.sold}/{r.lots}
        </b>
        <span>lots paid</span>
      </div>
      <div className="stat">
        <b className="t-mono">{money(r.rescuedCents)}</b>
        <span>saved by the line ({r.rescued})</span>
      </div>
      <div className="stat">
        <b>{r.waiting}</b>
        <span>waiting on payment</span>
      </div>
    </div>
  );
}

function Cohost({ session, webhooks }: { session: Session; webhooks: Array<{ text: string; at: number }> }) {
  const [q, setQ] = useState("");
  const [log, setLog] = useState<Array<{ q: string; a: string; steps: Array<{ tool: string; ok: boolean }> }>>([]);
  const [busy, setBusy] = useState(false);
  const ask = async (question: string) => {
    if (!question.trim()) return;
    setBusy(true);
    setQ("");
    try {
      const res = await api<{ text: string; steps: Array<{ tool: string; ok: boolean }> }>(`/api/shows/${session.showId}/cohost`, { question }, { "x-seller-key": session.sellerKey });
      setLog((l) => [...l, { q: question, a: res.text, steps: res.steps }]);
    } catch (e) {
      setLog((l) => [...l, { q: question, a: (e as Error).message, steps: [] }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel-card">
      <div className="panel-head">Co-host</div>
      <div className="panel-body" style={{ display: "grid", gap: 10 }}>
        <div className="chips">
          {["Who hasn't paid yet?", "How much did we make?", "Refund lot 1"].map((s) => (
            <button key={s} className="chip" onClick={() => ask(s)} disabled={busy}>
              {s}
            </button>
          ))}
        </div>
        {log.map((x, i) => (
          <div key={i} className="msg">
            <p className="msg__line">
              <span className="msg__who">You</span>
              {x.q}
            </p>
            <p className="msg__line" style={{ color: "var(--ink-2)" }}>
              {x.a}
            </p>
            {x.steps.length > 0 && (
              <div className="msg__meta">
                {x.steps.map((s, j) => (
                  <span key={j} className={`pill ${s.ok ? "pill--model" : "pill--lapsed"}`}>
                    {s.tool}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(q);
          }}
        >
          <input className="input grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask or tell it to do something" aria-label="Ask the co-host" />
          <button className="btn btn-ink btn-sm" disabled={busy}>
            {busy ? "…" : "Ask"}
          </button>
        </form>
        {webhooks.length > 0 && (
          <div className="creds" aria-label="Recent PayPal webhooks">
            {webhooks.slice(0, 4).map((w, i) => (
              <div key={i}>{w.text}</div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
