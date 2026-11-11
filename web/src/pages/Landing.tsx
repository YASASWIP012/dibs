import { useEffect } from "react";
import { Logo } from "../lib/ui";

const GITHUB = "https://github.com/YASASWIP012/dibs";

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const icons = {
  chat: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  card: "M3 7h18v10H3zM3 11h18M7 15h3",
  camera: "M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6",
  hook: "M8 3v6a4 4 0 0 0 8 0V3M12 13v8",
  lang: "M4 5h9M8.5 3v2M6 5c0 4 3 7 7 8M11 5c-1 4-4 7-7 8M14 21l4-9 4 9M15.5 18h5",
  shield: "M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z",
};

/** Static picture of the studio for the hero. Real components, plausible data, not interactive. */
function HeroVisual() {
  const lots = [
    { n: 3, t: "Leather crossbody", p: "$35", who: "@priya", s: "held", left: "0:41", pct: 0.7 },
    { n: 2, t: "Ceramic table lamp", p: "$28", who: "@kenji", s: "paid", left: "", pct: 1 },
    { n: 1, t: "Denim trucker jacket", p: "$40", who: "@lucia", s: "paid", left: "", pct: 1, lapsed: "@jake" },
  ];
  return (
    <div className="stage" aria-hidden="true">
      <div className="window" style={{ maxWidth: 980, margin: "0 auto" }}>
        <div className="window__bar">
          <div className="lights">
            <i />
            <i />
            <i />
          </div>
          <span className="window__title">Dibs studio</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1.25fr 1fr", gap: 14, padding: 16, background: "var(--bg-alt)" }} className="hero-mock">
          <div style={{ display: "grid", gap: 10 }}>
            <div className="stats" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
              <div className="stat is-accent">
                <b className="t-mono">$103</b>
                <span>paid through PayPal</span>
              </div>
              <div className="stat">
                <b>2/3</b>
                <span>lots paid</span>
              </div>
              <div className="stat">
                <b className="t-mono">$40</b>
                <span>saved by the line</span>
              </div>
            </div>
            {lots.map((l) => (
              <div key={l.n} className="holder" style={{ background: "var(--surface)" }}>
                <span className="code t-mono" style={{ fontSize: 12 }}>#{l.n}</span>
                <span className="grow" style={{ fontWeight: 600 }}>
                  {l.t} <span className="t-mono" style={{ fontWeight: 400, color: "var(--ink-3)" }}>{l.p}</span>
                </span>
                {l.lapsed && <span className="pill pill--lapsed">{l.lapsed}</span>}
                <span className={`ring${l.s === "paid" ? " is-paid" : ""}`} style={{ "--p": l.pct } as React.CSSProperties} />
                <span className="who" style={{ fontWeight: 600 }}>{l.who}</span>
                {l.s === "paid" ? <span className="pill pill--sold">Paid</span> : <span className="t-mono">{l.left}</span>}
              </div>
            ))}
          </div>
          <div className="panel-card" style={{ padding: "12px 14px", display: "grid", gap: 8, alignContent: "start" }}>
            {[
              ["@lucia", "yo quiero la chaqueta 🙋‍♀️", "claim #1", "es"],
              ["@kenji", "2番ください", "claim #2", "ja"],
              ["@sam", "that wash is so good", "chatter", "en"],
              ["@priya", "मुझे चाहिए 3", "claim #3", "hi"],
            ].map(([who, text, kind, lang]) => (
              <div key={who} className="msg">
                <p className="msg__line">
                  <span className="msg__who">{who}</span>
                  {text}
                </p>
                <div className="msg__meta">
                  <span className={`pill ${kind === "chatter" ? "pill--open" : "pill--held"}`}>{kind}</span>
                  <span className="pill pill--rules">{lang}</span>
                </div>
              </div>
            ))}
            <div className="msg msg--paypal">
              <p className="msg__line">PAYMENT.CAPTURE.COMPLETED · verified</p>
            </div>
          </div>
        </div>
      </div>
      <div className="float" style={{ left: "3%", bottom: "12%", maxWidth: 250 }}>
        <div className="row" style={{ gap: 8, marginBottom: 4 }}>
          <span className="pill pill--held">Rolled over</span>
        </div>
        @jake didn't pay in 2:00. Lot 1 went to @lucia, who paid.
      </div>
    </div>
  );
}

export function Landing() {
  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))), { rootMargin: "0px 0px -8% 0px" });
    document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <>
      <nav className="nav nav--on-color" aria-label="Main">
        <div className="nav__bar">
          <a className="nav__brand" href="/">
            <Logo /> Dibs
          </a>
          <div className="nav__links">
            <a href="#how">How it works</a>
            <a href="#paypal">PayPal</a>
            <a href="#faq">FAQ</a>
            <a href={GITHUB}>Code</a>
          </div>
          <a className="btn btn-ink btn-sm" href="/demo">
            Try the demo show
          </a>
        </div>
      </nav>

      <header className="hero hero--color">
        <div className="container">
          <span className="badge" style={{ color: "var(--ink-2)" }}>
            <span className="badge__tag">Sandbox</span> Built for the PayPal AI Hackathon
          </span>
          <h1>
            Sell it live. <span className="t-muted">Get paid before the next item.</span>
          </h1>
          <p className="lead">
            Dibs reads your live-sale chat in any language, holds each item for whoever called it first, sends them a PayPal checkout, and moves anything unpaid to the next person in line.
          </p>
          <div className="cta-row">
            <a className="btn btn-halo btn-lg" href="/demo">
              Try the demo show
            </a>
            <a className="btn btn-outline btn-lg" href="/studio">
              Start your own show
            </a>
          </div>
          <div className="trust">
            <span>No install</span>
            <span>PayPal sandbox, no real money</span>
            <span>Open source, MIT</span>
          </div>
          <div className="hero__visual">
            <HeroVisual />
          </div>
        </div>
      </header>

      <section className="section" id="how">
        <div className="container">
          <div className="section-head">
            <span className="eyebrow">
              <span className="dot" /> The problem
            </span>
            <h2>“Sold!” is easy. Getting paid isn't.</h2>
            <p className="lead">
              Small resellers sell thrift, vintage, sneakers and plants on live video. Buyers shout claims in chat, someone writes names on paper, invoices go out hours later, and some buyers never pay. The item sits on hold while the next person who wanted it has already logged off.
            </p>
          </div>
          <div className="grid grid-2">
            <div className="card card--flat reveal">
              <p className="t-title">Today</p>
              <ul className="checklist" style={{ color: "var(--ink-3)" }}>
                <li>Scroll back through chat to see who typed first</li>
                <li>Copy names into a spreadsheet mid-show</li>
                <li>Send payment requests one by one after the show</li>
                <li>Chase people who don't pay, then try to resell</li>
              </ul>
            </div>
            <div className="card card--chosen reveal" style={{ "--i": 1 } as React.CSSProperties}>
              <p className="t-title">With Dibs</p>
              <ul className="checklist">
                <li>Claims are read and timestamped the moment they land</li>
                <li>The first claimer gets a PayPal checkout on their phone</li>
                <li>A clock runs; unpaid items move down the line on their own</li>
                <li>The board turns green when PayPal confirms the payment</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="section section--alt">
        <div className="container stack">
          <div className="split reveal">
            <div>
              <span className="eyebrow">
                <Icon d={icons.lang} /> Claims in any language
              </span>
              <h3>“Mine!”, “yo quiero 14”, “मेरा”, 🙋.</h3>
              <p className="lead">
                Clear claims are decided by plain rules in milliseconds, so the first person to type always wins. Gemini reads the rest: slang, other scripts, and the “not mine, my sister wants it” messages that keyword tools get wrong.
              </p>
              <div className="chips">
                <span className="chip">Server timestamps</span>
                <span className="chip">Replies in the buyer's language</span>
                <span className="chip">Shows how each line was read</span>
              </div>
            </div>
            <div className="stage stage--soft">
              <div className="card" style={{ display: "grid", gap: 10 }}>
                {[
                  ["@jake", "mine!!", "claim #1", "keyword rules"],
                  ["@lucia", "yo quiero la chaqueta 🙋‍♀️", "claim #1", "keyword rules"],
                  ["@mo", "lol not mine, my sister's", "chatter", "read by Gemini"],
                ].map(([w, t, k, v]) => (
                  <div key={w} className="msg" aria-hidden="true">
                    <p className="msg__line">
                      <span className="msg__who">{w}</span>
                      {t}
                    </p>
                    <div className="msg__meta">
                      <span className={`pill ${k === "chatter" ? "pill--open" : "pill--held"}`}>{k}</span>
                      <span className={`pill ${v?.startsWith("read") ? "pill--model" : "pill--rules"}`}>{v}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="split split--flip reveal">
            <div>
              <span className="eyebrow">
                <Icon d={icons.clock} /> The claim clock
              </span>
              <h3>Unpaid items find the next buyer.</h3>
              <p className="lead">
                Each claim holds the item for a set time. If PayPal hasn't confirmed payment when it runs out, the hold passes to the next person in line and they get a message in their own language. If a buyer approves in PayPal after their time is up, Dibs refuses the capture, so nobody pays for something that already went to someone else.
              </p>
            </div>
            <div className="stage stage--soft">
              <div className="card" style={{ display: "grid", gap: 10 }} aria-hidden="true">
                <div className="holder">
                  <span className="ring is-low" style={{ "--p": 0.05 } as React.CSSProperties} />
                  <span className="who">@jake</span>
                  <span className="t-mono">0:03</span>
                </div>
                <div className="holder" style={{ background: "var(--sky)" }}>
                  <span className="ring" style={{ "--p": 1 } as React.CSSProperties} />
                  <span className="who">@lucia</span>
                  <span className="grow t-small">¡Buenas noticias! El lote 1 ahora es tuyo.</span>
                  <span className="t-mono">2:00</span>
                </div>
              </div>
            </div>
          </div>

          <div className="split reveal" id="paypal">
            <div>
              <span className="eyebrow">
                <Icon d={icons.card} /> PayPal does the money
              </span>
              <h3>One checkout per buyer, confirmed by webhook.</h3>
              <p className="lead">
                Everything a buyer holds goes into a single Orders v2 order with a line per lot, created through the PayPal TypeScript Server SDK. Buyers pay with PayPal, Venmo or Pay Later. Captures are idempotent and every webhook is checked with PayPal's signature verification before it can mark anything paid.
              </p>
              <div className="chips">
                <span className="chip">Orders v2</span>
                <span className="chip">Server SDK</span>
                <span className="chip">Verified webhooks</span>
                <span className="chip">Order tracking</span>
                <span className="chip">Agent Toolkit</span>
              </div>
            </div>
            <div className="stage stage--soft">
              <div className="card" style={{ display: "grid", gap: 8, fontFamily: "var(--font-mono)", fontSize: 13 }} aria-hidden="true">
                <span>POST /v2/checkout/orders · 2 items · $63.00</span>
                <span>buyer approves in PayPal</span>
                <span>POST /v2/checkout/orders/…/capture → COMPLETED</span>
                <span style={{ color: "var(--paid)" }}>webhook PAYMENT.CAPTURE.COMPLETED · signature verified</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <span className="eyebrow">
              <span className="dot" /> Also in the box
            </span>
            <h2>Built for one person running the whole show.</h2>
          </div>
          <div className="grid grid-3">
            {[
              [icons.camera, "Say it, list it", "Hold the item up and say “lot three, leather bag, thirty five”. The camera frame and your words become a listing with an honest one-line description."],
              [icons.spark, "A co-host you can talk to", "Ask “who hasn't paid?” or say “refund lot 2”. It reads the show and acts through the PayPal Agent Toolkit."],
              [icons.chat, "Live captions", "Buyers see what you're saying as you say it, which helps when they're watching on mute."],
              [icons.hook, "Real-time everywhere", "The studio and every phone share one clock from the server, so countdowns match to the second."],
              [icons.shield, "Fails safe", "If the model is slow or over quota, keyword rules take over. A bad read can never charge anyone; only PayPal's capture marks a sale."],
              [icons.clock, "Recap", "Money in, lots sold, and how much the waiting line saved you, live during the show."],
            ].map(([d, t, p], i) => (
              <div className="tile reveal" key={t} style={{ "--i": i % 3 } as React.CSSProperties}>
                <span className="icon-tile">
                  <Icon d={d!} />
                </span>
                <div>
                  <p className="t-title">{t}</p>
                  <p>{p}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section section--alt" id="faq">
        <div className="container">
          <div className="section-head">
            <h2>Questions.</h2>
          </div>
          <div className="faq">
            {[
              ["Is this real money?", "No. Dibs runs on the PayPal sandbox, so every payment is a test payment. The PayPal calls themselves are real: real orders, real captures, real webhooks."],
              ["Does it work with Instagram or TikTok Live?", "Not yet. Their live comment APIs need app review, so today you run the show from the Dibs studio and share a link. Connecting YouTube Live chat and Instagram's live comments webhook is the next step."],
              ["What decides who gets an item?", "Plain code. The server records when each message arrives, and the first valid claim holds the item. The model only helps read messages; it never picks a winner or moves money."],
              ["What happens if a buyer pays late?", "If their hold ran out, Dibs refuses to capture the payment, so their PayPal account isn't charged, and they're told the item went to the next person."],
              ["Which AI does it use?", "Google Gemini, for reading chat, writing listings from the camera and your words, translating replies, and the co-host."],
              ["Can I see the code?", "Yes. It's open source under the MIT license."],
            ].map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="section" style={{ textAlign: "center" }}>
        <div className="container">
          <img src="/icon.svg" width={88} height={88} alt="" style={{ margin: "0 auto 24px", borderRadius: 22, boxShadow: "var(--shadow-2)" }} />
          <h2>
            Run a show. <span className="t-muted">Watch it pay.</span>
          </h2>
          <div className="cta-row">
            <a className="btn btn-candy btn-lg" href="/demo">
              Try the demo show
            </a>
            <a className="btn btn-outline btn-lg" href="/studio">
              Start your own show
            </a>
          </div>
        </div>
      </section>

      <footer className="footer">
        <div className="container">
          <span className="row" style={{ gap: 8 }}>
            <Logo size={20} /> Dibs
          </span>
          <span>
            <a href={GITHUB}>Source on GitHub</a> · MIT license · PayPal sandbox only
          </span>
        </div>
      </footer>
    </>
  );
}
