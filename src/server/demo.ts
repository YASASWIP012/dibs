import type { Room } from "./room.js";

/**
 * Judge mode. A scripted show that runs on the real engine: lots open, other viewers claim
 * in four languages, one of them never pays, and the item rolls to the judge, who pays
 * in the real PayPal sandbox. Nothing on screen is faked except the other viewers.
 */

export interface DemoLot {
  number: number;
  title: string;
  description: string;
  priceCents: number;
  photo?: string;
  spoken: string;
}

export const DEMO_LOTS: DemoLot[] = [
  { number: 1, title: "Denim trucker jacket", description: "Medium wash, size M, light fading on the cuffs.", priceCents: 4000, spoken: "Lot one, denim trucker jacket, size medium, forty bucks", photo: "/demo/lot-1.jpg" },
  { number: 2, title: "Ceramic table lamp", description: "Glazed green base with a linen shade. Works.", priceCents: 2800, spoken: "Lot two, this green ceramic lamp, twenty eight", photo: "/demo/lot-2.jpg" },
  { number: 3, title: "Leather crossbody bag", description: "Brown leather, adjustable strap, a few scuffs on the base.", priceCents: 3500, spoken: "Lot three, brown leather crossbody, thirty five", photo: "/demo/lot-3.jpg" },
];

type Step = { at: number; run: (room: Room) => void | Promise<void> };

function bot(room: Room, handle: string, lang: string, text: string) {
  const buyer = room.show.join(handle, lang);
  return room.handleChat(buyer, text);
}

function lot(room: Room, n: number) {
  const l = DEMO_LOTS[n - 1]!;
  room.show.caption(l.spoken);
  room.show.openLot({ number: l.number, title: l.title, description: l.description, priceCents: l.priceCents, photo: l.photo, spoken: l.spoken });
}

export const DEMO_SCRIPT: Step[] = [
  { at: 500, run: (r) => r.show.caption("Hey everyone, welcome back. Three pieces tonight.") },
  { at: 2500, run: (r) => lot(r, 1) },
  { at: 4200, run: (r) => bot(r, "jake", "en", "mine!!") },
  { at: 5200, run: (r) => bot(r, "lucia", "es", "yo quiero la chaqueta 🙋‍♀️") },
  { at: 6400, run: (r) => bot(r, "priya", "hi", "मुझे चाहिए 1") },
  { at: 8000, run: (r) => bot(r, "sam", "en", "that wash is so good") },
  { at: 11000, run: (r) => lot(r, 2) },
  { at: 12500, run: (r) => bot(r, "kenji", "ja", "2番ください") },
  { at: 14500, run: (r) => bot(r, "ana", "pt", "is the shade included?") },
  { at: 20000, run: (r) => lot(r, 3) },
  { at: 21200, run: (r) => bot(r, "jake", "en", "sold 3") },
];

export function runDemo(room: Room): () => void {
  const timers = DEMO_SCRIPT.map((s) => setTimeout(() => void s.run(room), s.at));
  return () => timers.forEach(clearTimeout);
}
