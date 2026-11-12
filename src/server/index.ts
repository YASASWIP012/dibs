// Production entry: real Gemini, real PayPal sandbox, then listen.
import { config, paypalReady } from "./config.js";
import { Ai } from "./ai/gemini.js";
import { Cohost } from "./ai/cohost.js";
import { PayPal } from "./paypal/paypal.js";
import { buildApp } from "./app.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const WEBHOOK_EVENTS = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "CUSTOMER.DISPUTE.CREATED",
];

const ai = new Ai(config.GEMINI_API_KEY, config.GEMINI_MODEL, config.GEMINI_VISION_MODEL);

// Judge mode's scripted viewers always say the same things, so their replies are translated
// ahead of time (src/server/ai/demo-translations.json). Run with DIBS_SAVE_TRANSLATIONS=<file>
// and play judge mode a few times to refresh that file.
const translationsFile = new URL("./ai/demo-translations.json", import.meta.url);
if (existsSync(translationsFile)) ai.seedTranslations(JSON.parse(readFileSync(translationsFile, "utf8")));
if (process.env.DIBS_SAVE_TRANSLATIONS) {
  const out = process.env.DIBS_SAVE_TRANSLATIONS;
  setInterval(() => writeFileSync(out, JSON.stringify(ai.translations(), null, 1) + "\n"), 2000).unref();
}
const paypal = paypalReady ? new PayPal({ clientId: config.PAYPAL_CLIENT_ID!, clientSecret: config.PAYPAL_CLIENT_SECRET! }) : undefined;
const cohost =
  paypalReady && config.GEMINI_API_KEY
    ? new Cohost({ clientId: config.PAYPAL_CLIENT_ID!, clientSecret: config.PAYPAL_CLIENT_SECRET!, geminiKey: config.GEMINI_API_KEY, model: config.GEMINI_AGENT_MODEL })
    : undefined;

let webhookId = config.PAYPAL_WEBHOOK_ID;

const { app, tick } = await buildApp({
  ai,
  payments: paypal,
  webhooks: paypal ? { verify: (headers, body) => (webhookId ? paypal.verifyWebhook(webhookId, headers, body) : Promise.resolve(false)) } : undefined,
  cohost,
  paypalClientId: config.PAYPAL_CLIENT_ID,
  holdSeconds: config.HOLD_SECONDS,
  youtubeKey: config.YOUTUBE_API_KEY,
  demoBuyer: config.DEMO_BUYER_EMAIL ? { email: config.DEMO_BUYER_EMAIL, password: config.DEMO_BUYER_PASSWORD } : undefined,
});

setInterval(tick, 500).unref();
await app.listen({ port: config.PORT, host: "0.0.0.0" });

if (paypal && config.PUBLIC_URL && !webhookId) {
  paypal
    .ensureWebhook(`${config.PUBLIC_URL.replace(/\/$/, "")}/api/paypal/webhook`, WEBHOOK_EVENTS)
    .then((id) => {
      webhookId = id;
      app.log.info({ webhookId: id }, "PayPal webhook ready");
    })
    .catch((err) => app.log.warn({ err: String(err) }, "Could not register the PayPal webhook"));
}
