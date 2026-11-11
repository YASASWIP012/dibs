// Production entry: real Gemini, real PayPal sandbox, then listen.
import { config, paypalReady } from "./config.js";
import { Ai } from "./ai/gemini.js";
import { Cohost } from "./ai/cohost.js";
import { PayPal } from "./paypal/paypal.js";
import { buildApp } from "./app.js";

const WEBHOOK_EVENTS = ["CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED"];

const ai = new Ai(config.GEMINI_API_KEY, config.GEMINI_MODEL, config.GEMINI_VISION_MODEL);
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
