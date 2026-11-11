# Dibs

Dibs is for small resellers who sell on live video. It reads the chat, holds each item for whoever claimed it first, sends that buyer a PayPal checkout, and passes anything unpaid to the next person in line.

Built for the PayPal AI Hackathon. Everything runs on the PayPal sandbox; no real money moves.

## The problem

People sell thrift, vintage, sneakers and plants on live video, and in the US those shows sold about $14.6 billion of goods in 2025 ([eMarketer, via Digital Applied](https://www.digitalapplied.com/blog/social-commerce-statistics-2026-data-points)). The sales mechanic is a comment. A buyer types "mine" or "sold 14", and the seller (or a friend with a notepad) has to work out who typed first, then send payment requests by hand after the show. Guides for comment selling tell sellers to expect claims that never get paid and to set payment deadlines so the item can be released ([Racklify](https://racklify.com/encyclopedia/how-to-run-a-commentsold-comment-selling-event/)). By the time a seller notices, the second buyer has usually left.

Tools that automate this exist (CommentSold, SoldLive), but they charge a monthly fee, sit on top of a Shopify store, and match keywords. Dibs runs from one link, takes payment through PayPal, and reads claims the way people actually type them.

## Try it

| | |
|---|---|
| Judge mode (no setup) | `/demo`: a scripted show on the real engine. Other viewers are bots; the claim engine, Gemini and PayPal are live. Claim lot 3, watch the person ahead of you run out of time, then pay. |
| Sandbox buyer for checkout | shown on the judge-mode page (a PayPal sandbox personal account) |
| Seller studio | `/studio` |
| Buyer room | `/s/<show id>` (the studio gives you the link and a QR code) |
| Demo video | link on the Devpost page |

The demo show in the video was staged by the builder. No real seller has used Dibs yet.

## What happens in a show

1. The seller says what the item is. "Lot three, leather bag, thirty five." The browser's speech recognition hears it; Dibs grabs a camera frame and Gemini writes a two-to-five word title and one honest line about condition. The price and lot number come from the seller's words, never from the model.
2. Buyers claim however they talk. "mine!!", "yo quiero la chaqueta 🙋‍♀️", "मुझे चाहिए 1", "sold 14", a raised hand. Clear claims are decided by keyword rules in milliseconds. Gemini only reads what the rules can't place, like slang, other scripts and "lol not mine, my sister wants it". All chat goes through one queue per show, so claims land in the order the server received them, whatever the model's latency.
3. The first claimer gets a clock. The item is held for them (2:00 by default) and they get a PayPal button on their phone. Everyone else waits in line. Replies go out in each buyer's language.
4. Unpaid items move on. When a hold runs out without a captured payment, it passes to the next person in line, who is told in their own language. If the first buyer approves in PayPal after their time is up, Dibs refuses to capture, so they are not charged for something that went to someone else.
5. PayPal confirms the sale. Each buyer gets one Orders v2 order with a line per lot they hold. Capture is idempotent, and every webhook is checked with PayPal's signature verification before it can mark anything paid. The board turns green.
6. After the show, the seller asks the co-host. "Who hasn't paid?" "Refund lot 2." A Gemini function-calling loop reads the show and acts through the PayPal Agent Toolkit (`create_refund`, `get_order`, `list_transactions`, shipment tracking).

## Why PayPal

PayPal is the payment step and the source of truth for what is sold:

- Orders v2 through the PayPal TypeScript Server SDK (`@paypal/paypal-server-sdk`): one order per buyer, line items per lot, `PayPal-Request-Id` idempotency on create and capture.
- Capture is gated by the claim clock. The server checks every claim in the order is still held by that buyer before calling capture, and returns 409 if not.
- Webhooks (`PAYMENT.CAPTURE.COMPLETED`, `CHECKOUT.ORDER.APPROVED`, refunds) register themselves on deploy and are verified with `/v1/notifications/verify-webhook-signature`. A sale is applied once, whether the browser or the webhook arrives first.
- PayPal Agent Toolkit gives the co-host refunds, order lookups, transaction search and tracking.
- Buttons: PayPal, Venmo and Pay Later through the JS SDK.

## Why Gemini

| Job | Model | Fallback |
|---|---|---|
| Read unclear chat lines (structured JSON: claim / question / chatter, lots, language) | `gemini-3.5-flash-lite`, 2.5 s timeout | keyword rules |
| Write a listing from the spoken words and a camera frame | `gemini-3.5-flash` | title from the spoken words |
| Translate replies to each buyer | `gemini-3.5-flash-lite` | English |
| Co-host tool loop with the Agent Toolkit | `gemini-3.5-flash` | none (the seller can use PayPal directly) |

The model never decides who gets an item and never moves money on its own. Its output is validated with zod schemas, and a low-confidence model "claim" that the rules call chatter is treated as chatter.

## Evidence

Real sandbox run on 11 November 2026, through Dibs' own endpoints:

| | |
|---|---|
| Order | `19Y34583SB393764D`, 2 lots, $65.00, approved by a US sandbox buyer |
| Capture | `55L4149684291294L`, COMPLETED; a second capture call returned the same result without a new charge |
| Refund | $25.00 on lot 2, issued by the co-host through the Agent Toolkit's `create_refund` |

21 automated tests (`npm test`) cover the claim order, double claims, the claim clock and rollover, refusing capture after a hold lapses, idempotent capture, the recap, and the chat rules in seven languages.

## Limitations and next steps

- Shows run from the Dibs studio and a shared link. Instagram's live comments webhook needs Meta app review, and YouTube Live chat has a public API; connecting those is the next step.
- Video to buyers is a 5 fps JPEG stream over WebSocket, which is fine for showing items and not for long shows. WebRTC would replace it.
- Shows live in memory on one server process; a restart ends them. A database comes before any real seller uses it.
- The free Gemini tier is slow (1 to 2.5 s) and small. The rules handle the clear cases, so a show keeps working when the model is out of quota.
- Sandbox only. Live payments would need PayPal onboarding for each seller (PayPal Commerce Platform).

## Run it locally

```bash
npm install
cp .env.example .env.local   # add PayPal sandbox and Gemini keys
npm run dev                  # API and WebSocket on :8787
npm run dev:web              # web app on :5173
npm test
```

The PayPal app must belong to a sandbox business account in a country that can receive the buyer's payment (a US business and a US buyer work).

## Repository map

```
src/server/domain/   claim engine, claim clock, rules parser (pure, tested)
src/server/paypal/   Orders v2 via the Server SDK, webhook registration and verification
src/server/ai/       Gemini calls with fallbacks; co-host loop with the PayPal Agent Toolkit
src/server/room.ts   one show: sockets, chat queue, replies, checkout
src/server/demo.ts   judge mode script
web/src/pages/       landing, studio, buyer room, judge mode
test/                vitest
```

## Credits

Lot photos in judge mode are from Pexels; see `web/public/demo/CREDITS.txt`. MIT license.
