export type Money = { cents: number; currency: "USD" };

export type LotStatus = "open" | "held" | "sold" | "unsold";

export interface Lot {
  number: number;
  title: string;
  description: string;
  price: Money;
  /** Small JPEG data URL grabbed from the seller's camera when the lot was called. */
  photo?: string;
  status: LotStatus;
  createdAt: number;
  /** What the seller actually said, kept so a judge can compare it with what the AI wrote. */
  spoken?: string;
}

export type ClaimStatus = "holding" | "waiting" | "paid" | "lapsed";

export interface Claim {
  id: string;
  lotNumber: number;
  buyerId: string;
  handle: string;
  text: string;
  lang: string;
  receivedAt: number;
  status: ClaimStatus;
  /** Set when the claim starts holding the lot. */
  holdStartedAt?: number;
  /** Payment must be captured before this time or the lot moves to the next person in line. */
  deadline?: number;
  orderId?: string;
}

export interface Buyer {
  id: string;
  handle: string;
  lang: string;
  joinedAt: number;
}

export type OrderStatus = "created" | "captured" | "rejected";

export interface PendingOrder {
  id: string;
  buyerId: string;
  claimIds: string[];
  total: Money;
  status: OrderStatus;
  createdAt: number;
  captureId?: string;
  refundedCents?: number;
}

export interface ChatMessage {
  id: string;
  buyerId: string;
  handle: string;
  text: string;
  at: number;
  /** How the message was understood, shown in the studio so the seller can see why. */
  reading?: ClaimReading;
  /** Replies from Dibs to this buyer, in their language. */
  system?: boolean;
}

export type ClaimReading =
  | { kind: "claim"; lotNumbers: number[]; size?: string; lang: string; confidence: number; via: "model" | "rules" }
  | { kind: "question"; lang: string; via: "model" | "rules" }
  | { kind: "chatter"; lang: string; via: "model" | "rules" };

export type ShowEvent =
  | { type: "lot.opened"; lot: Lot }
  | { type: "lot.updated"; lot: Lot }
  | { type: "claim.created"; claim: Claim }
  | { type: "claim.holding"; claim: Claim }
  | { type: "claim.lapsed"; claim: Claim; next?: Claim }
  | { type: "claim.paid"; claim: Claim }
  | { type: "order.created"; order: PendingOrder }
  | { type: "order.captured"; order: PendingOrder }
  | { type: "chat"; message: ChatMessage }
  | { type: "caption"; text: string; at: number }
  | { type: "webhook"; eventType: string; verified: boolean; id: string; at: number };
