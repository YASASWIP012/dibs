import { useEffect, useMemo, useState } from "react";
import { api, money } from "../lib/api";
import { useShow } from "../lib/useShow";
import { LotCard, Logo } from "../lib/ui";
import { ChatPanel, Recap } from "./Studio";
import { Room } from "./Room";

interface Config {
  paypalClientId: string | null;
  demoBuyer: { email: string; password?: string } | null;
}

/**
 * Judge mode: the seller's view on the left, a buyer's phone on the right, one real show.
 * The other viewers are scripted; the claim engine, the model and PayPal are real.
 */
export function Demo() {
  const [showId, setShowId] = useState<string | null>(null);
  const [cfg, setCfg] = useState<Config | null>(null);
  const live = useShow(showId ?? undefined, "watch");
  const { show, now } = live;

  useEffect(() => {
    // ?watch=<id> opens a judge-mode show that is already running (to share or screenshot it)
    const watch = new URLSearchParams(location.search).get("watch");
    if (watch && /^[\w-]{4,40}$/.test(watch)) {
      setShowId(watch);
      return;
    }
    api<{ showId: string; demoBuyer: Config["demoBuyer"] }>("/api/demo", {}).then((r) => {
      setShowId(r.showId);
      setCfg({ paypalClientId: null, demoBuyer: r.demoBuyer });
    });
  }, []);

  const me = useMemo(() => {
    if (!showId) return null;
    try {
      return JSON.parse(localStorage.getItem(`dibs:buyer:${showId}`) ?? "null") as { id: string } | null;
    } catch {
      return null;
    }
  }, [showId, show?.buyers.length]);

  const myClaims = show && me ? show.claims.filter((c) => c.buyerId === me.id) : [];
  const steps = [
    { label: "Watch lots come up and see how each chat line is read, in four languages", done: (show?.lots.length ?? 0) >= 3 },
    { label: "Join on the phone and claim lot 3 (tap Dibs, or type “mine 3”)", done: myClaims.some((c) => c.lotNumber === 3) },
    { label: "@jake got there first and won't pay. Watch his clock run out", done: myClaims.some((c) => c.lotNumber === 3 && c.status !== "waiting") },
    { label: "It's yours now. Pay with the sandbox buyer below", done: myClaims.some((c) => c.status === "paid") },
    { label: "The board turns green and PayPal's webhook lands", done: live.webhooks.length > 0 },
  ];
  const nowIdx = steps.findIndex((s) => !s.done);

  return (
    <div className="app">
      <header className="app-top">
        <a className="brand" href="/">
          <Logo /> Dibs
        </a>
        <span className="pill pill--open">Judge mode</span>
        <span className="hint">A scripted show on the real engine. The other viewers are bots with pre-translated replies; PayPal is live, and Gemini reads what you type. Holds last 0:40 here so you see a rollover quickly (real shows default to 2:00).</span>
        <span className="spacer" />
        <button className="btn btn-outline btn-sm" onClick={() => location.reload()}>
          Restart
        </button>
      </header>
      <main className="judge">
        <div style={{ display: "grid", gap: 16 }}>
          <Recap show={show} />
          <section className="panel-card">
            <div className="panel-head">Seller's claim board</div>
            <div className="panel-body">
              {show && show.lots.length ? (
                <div className="board" aria-live="polite" aria-relevant="additions text">
                  {[...show.lots]
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .map((l) => (
                      <LotCard key={l.number} lot={l} show={show} now={now} fresh={now - l.createdAt < 4000} />
                    ))}
                </div>
              ) : (
                <p className="hint">The show starts in a second…</p>
              )}
            </div>
          </section>
          <ChatPanel show={show} />
          {show && show.orders.length > 0 && <PayPalPanel show={show} />}
          {live.suggestions.length > 0 && (
            <section className="panel-card" aria-live="polite">
              <div className="panel-head">Co-host, working the show (reminders go out on their own; money waits for the seller)</div>
              <div className="panel-body" style={{ display: "grid", gap: 6 }}>
                {live.suggestions.slice(-4).map((p) => (
                  <div key={p.id} className="holder">
                    <span className={`pill ${p.done ? "pill--sold" : "pill--model"}`}>{p.done ? "sent" : p.kind}</span>
                    <span className="grow">{p.label}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
        <aside style={{ display: "grid", gap: 16, position: "sticky", top: 76 }}>
          <section className="panel-card">
            <div className="panel-head">Try it</div>
            <div className="panel-body" style={{ display: "grid", gap: 12 }}>
              <ol className="steps">
                {steps.map((s, i) => (
                  <li key={i} className={s.done ? "done" : i === nowIdx ? "now" : ""}>
                    {s.label}
                  </li>
                ))}
              </ol>
              {cfg?.demoBuyer ? (
                <div className="creds" aria-label="Sandbox buyer login">
                  PayPal sandbox test buyer (sandbox only, no real money)
                  <br />
                  {cfg.demoBuyer.email}
                  <br />
                  {cfg.demoBuyer.password}
                </div>
              ) : (
                <p className="hint">Use any PayPal sandbox personal account to pay.</p>
              )}
            </div>
          </section>
          <div className="phone" aria-label="Buyer's phone">
            <div className="phone__screen">{showId && <Room showId={showId} embedded />}</div>
          </div>
        </aside>
      </main>
    </div>
  );
}

/** What PayPal returned for this show: real sandbox order and capture IDs, and each verified webhook. */
function PayPalPanel({ show }: { show: NonNullable<ReturnType<typeof useShow>["show"]> }) {
  const handle = (id: string) => show.buyers.find((b) => b.id === id)?.handle ?? show.claims.find((c) => c.buyerId === id)?.handle ?? "buyer";
  const hooks = show.chat.filter((m) => m.system && m.handle === "paypal");
  return (
    <section className="panel-card" aria-live="polite">
      <div className="panel-head">PayPal, this show (sandbox)</div>
      <div className="panel-body" style={{ display: "grid", gap: 8 }}>
        {show.orders.map((o) => (
          <div key={o.id} className="holder" style={{ flexWrap: "wrap", gap: 8 }}>
            <span className={`pill ${o.status === "captured" ? "pill--sold" : "pill--model"}`}>{o.status === "captured" ? "captured" : o.status === "capturing" ? "pending at PayPal" : o.status}</span>
            <span className="grow">
              @{handle(o.buyerId)} · {money(o.total.cents)}
            </span>
            <span className="t-mono t-small">order {o.id}</span>
            {o.captureId && <span className="t-mono t-small">capture {o.captureId}</span>}
          </div>
        ))}
        {hooks.slice(-4).map((m) => (
          <div key={m.id} className="holder">
            <span className="pill pill--sold">webhook</span>
            <span className="grow t-mono t-small">{m.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
