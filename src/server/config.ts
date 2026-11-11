import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";

// Load .env.local without a dependency. Real deployments set env vars directly.
for (const file of [".env.local", ".env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] !== "" && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

const Env = z.object({
  PORT: z.coerce.number().default(8787),
  PUBLIC_URL: z.string().url().optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  DEMO_BUYER_EMAIL: z.string().optional(),
  DEMO_BUYER_PASSWORD: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash-lite"),
  GEMINI_VISION_MODEL: z.string().default("gemini-3.5-flash"),
  GEMINI_AGENT_MODEL: z.string().default("gemini-3.5-flash"),
  HOLD_SECONDS: z.coerce.number().int().min(15).max(3600).default(120),
});

export const config = Env.parse(process.env);
export const paypalReady = Boolean(config.PAYPAL_CLIENT_ID && config.PAYPAL_CLIENT_SECRET);
