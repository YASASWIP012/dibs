import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  ItemCategory,
  LogLevel,
  OrdersController,
} from "@paypal/paypal-server-sdk";
import type { Claim, Lot } from "../domain/types.js";

const API_BASE = "https://api-m.sandbox.paypal.com";

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
}

export interface OrderLine {
  claim: Claim;
  lot: Lot;
}

const usd = (cents: number) => (cents / 100).toFixed(2);

/**
 * Thin wrapper over the PayPal TypeScript Server SDK (Orders v2) plus the two REST
 * calls the SDK doesn't cover: webhook registration and webhook signature checks.
 * Sandbox only, on purpose.
 */
export class PayPal {
  private readonly orders: OrdersController;
  private token?: { value: string; expiresAt: number };

  constructor(private readonly cfg: PayPalConfig) {
    const client = new Client({
      clientCredentialsAuthCredentials: { oAuthClientId: cfg.clientId, oAuthClientSecret: cfg.clientSecret },
      environment: Environment.Sandbox,
      timeout: 15_000,
      logging: { logLevel: LogLevel.Warn, logRequest: { logBody: false }, logResponse: { logHeaders: false } },
    });
    this.orders = new OrdersController(client);
  }

  /** One order per buyer, one line per lot they hold. customId ties it back to the show. */
  async createOrder(showId: string, buyerHandle: string, lines: OrderLine[], requestId: string, payeeEmail?: string) {
    const total = lines.reduce((s, l) => s + l.lot.price.cents, 0);
    const res = await this.orders.createOrder({
      paypalRequestId: requestId,
      prefer: "return=minimal",
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [
          {
            referenceId: showId,
            customId: `${showId}:${buyerHandle}`.slice(0, 127),
            description: `Live sale ${showId}`,
            softDescriptor: "DIBS LIVE",
            // the seller's own PayPal account receives the money when they gave one
            payee: payeeEmail ? { emailAddress: payeeEmail } : undefined,
            amount: {
              currencyCode: "USD",
              value: usd(total),
              breakdown: { itemTotal: { currencyCode: "USD", value: usd(total) } },
            },
            items: lines.map(({ lot }) => ({
              name: `Lot ${lot.number}: ${lot.title}`.slice(0, 127),
              description: lot.description.slice(0, 127) || undefined,
              sku: `lot-${lot.number}`,
              quantity: "1",
              category: ItemCategory.PhysicalGoods,
              unitAmount: { currencyCode: "USD", value: usd(lot.price.cents) },
            })),
          },
        ],
      },
    });
    const id = res.result.id;
    if (!id) throw new Error("PayPal returned an order without an id");
    return { id, status: res.result.status };
  }

  /** Capture is idempotent on our side too: the request id is the order id. */
  /**
   * The request id is per attempt: a network retry of the same attempt is a no-op for PayPal,
   * but a retry after a decline (the buyer picked another card) is a new capture.
   */
  async captureOrder(orderId: string, attempt = 0) {
    try {
      const res = await this.orders.captureOrder({ id: orderId, paypalRequestId: `cap-${orderId}-${attempt}`, prefer: "return=representation" });
      const capture = res.result.purchaseUnits?.[0]?.payments?.captures?.[0];
      return { status: res.result.status, captureId: capture?.id, captureStatus: capture?.status as string | undefined, payer: res.result.payer?.emailAddress };
    } catch (err) {
      if (err instanceof ApiError && /ORDER_ALREADY_CAPTURED/.test(String(err.body))) {
        return this.getOrder(orderId);
      }
      throw err;
    }
  }

  /**
   * Refunds part of a capture. The request id comes from the seller's confirmed proposal, so a
   * timed-out refund can be retried safely: PayPal returns the first result instead of paying twice.
   */
  async refundCapture(captureId: string, cents: number, requestId: string, note: string): Promise<{ id?: string; status?: string }> {
    const res = await fetch(`${API_BASE}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json", "PayPal-Request-Id": requestId, Prefer: "return=representation" },
      body: JSON.stringify({ amount: { value: (cents / 100).toFixed(2), currency_code: "USD" }, note_to_payer: note.slice(0, 255) }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; status?: string; message?: string };
    if (!res.ok) throw Object.assign(new Error(body.message ?? `PayPal refund failed (${res.status})`), { status: res.status });
    return { id: body.id, status: body.status };
  }

  /** What PayPal says about an order right now. Used to reconcile after a capture call fails. */
  async getOrder(orderId: string) {
    const order = await this.orders.getOrder({ id: orderId });
    const capture = order.result.purchaseUnits?.[0]?.payments?.captures?.[0];
    return { status: order.result.status, captureId: capture?.id, captureStatus: capture?.status as string | undefined, payer: order.result.payer?.emailAddress };
  }

  async addTracking(orderId: string, captureId: string, trackingNumber: string, carrier = "USPS") {
    const res = await this.orders.createOrderTracking({
      id: orderId,
      body: { captureId, trackingNumber, carrier: carrier as never, notifyPayer: true },
    });
    return res.result.status;
  }

  // ---------- REST helpers for webhooks ----------

  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await fetch(`${API_BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`PayPal auth failed: ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  private async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`PayPal ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Makes sure a webhook points at this deployment. Returns its id. */
  async ensureWebhook(url: string, events: string[]): Promise<string> {
    const list = await this.rest<{ webhooks: Array<{ id: string; url: string }> }>("GET", "/v1/notifications/webhooks");
    const found = list.webhooks.find((w) => w.url === url);
    if (found) return found.id;
    const created = await this.rest<{ id: string }>("POST", "/v1/notifications/webhooks", {
      url,
      event_types: events.map((name) => ({ name })),
    });
    return created.id;
  }

  /** Asks PayPal whether a webhook delivery is genuine. Never trust the body without this. */
  async verifyWebhook(webhookId: string, headers: Record<string, string | string[] | undefined>, event: unknown): Promise<boolean> {
    const h = (k: string) => {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    const res = await this.rest<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: webhookId,
      webhook_event: event,
    });
    return res.verification_status === "SUCCESS";
  }
}
