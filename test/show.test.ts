import { describe, expect, it } from "vitest";
import { Show, ShowError } from "../src/server/domain/show.js";
import { readChatByRules } from "../src/server/domain/rulesParser.js";

function setup(holdMs = 60_000) {
  let t = 1_000;
  const clock = { advance: (ms: number) => (t += ms) };
  const show = new Show({ holdMs, now: () => t });
  const maria = show.join("maria", "es");
  const jake = show.join("@jake");
  const ana = show.join("ana");
  show.openLot({ number: 14, title: "Denim jacket", priceCents: 4000 });
  return { show, clock, maria, jake, ana };
}

describe("claims", () => {
  it("gives the lot to whoever the server heard first", () => {
    const { show, maria, jake } = setup();
    show.claim(jake.id, 14, "mine", "en", 1_001);
    show.claim(maria.id, 14, "yo quiero", "es", 1_000);
    // receivedAt decides order, but the first claim to arrive took the hold
    expect(show.holder(14)?.handle).toBe("jake");
    expect(show.waitlist(14).map((c) => c.handle)).toEqual(["maria"]);
  });

  it("ignores a second claim from the same buyer", () => {
    const { show, jake } = setup();
    const a = show.claim(jake.id, 14, "mine", "en");
    const b = show.claim(jake.id, 14, "MINE!!", "en");
    expect(b.id).toBe(a.id);
    expect(show.claimsFor(14)).toHaveLength(1);
  });

  it("refuses claims on missing or sold lots", () => {
    const { show, jake } = setup();
    expect(() => show.claim(jake.id, 99, "99", "en")).toThrow(ShowError);
  });
});

describe("claim clock", () => {
  it("rolls an unpaid lot to the next person in line", () => {
    const { show, clock, maria, jake } = setup(60_000);
    show.claim(jake.id, 14, "mine", "en");
    show.claim(maria.id, 14, "yo quiero", "es");
    clock.advance(59_999);
    expect(show.tick()).toHaveLength(0);
    clock.advance(1);
    const [roll] = show.tick();
    expect(roll?.lapsed.handle).toBe("jake");
    expect(roll?.next?.handle).toBe("maria");
    expect(show.holder(14)?.handle).toBe("maria");
    expect(show.holder(14)?.deadline).toBe(1_000 + 60_000 + 60_000);
  });

  it("reopens the lot when nobody is waiting", () => {
    const { show, clock, jake } = setup(1_000);
    show.claim(jake.id, 14, "mine", "en");
    clock.advance(1_000);
    show.tick();
    expect(show.lots.get(14)?.status).toBe("open");
  });
});

describe("checkout", () => {
  it("bundles every held lot into one order and marks them sold once", () => {
    const { show, jake } = setup();
    show.openLot({ number: 15, title: "Pothos cutting", priceCents: 1200 });
    show.claim(jake.id, 14, "14", "en");
    show.claim(jake.id, 15, "15", "en");
    const claims = show.payable(jake.id);
    const order = show.recordOrder("ORDER-1", jake.id, claims);
    expect(order.total.cents).toBe(5200);
    show.assertCapturable("ORDER-1");
    show.markCaptured("ORDER-1", "CAP-1");
    show.markCaptured("ORDER-1", "CAP-1"); // webhook arrives after the browser
    expect(show.lots.get(14)?.status).toBe("sold");
    expect(show.recap().soldCents).toBe(5200);
  });

  it("will not take money for an item that already went to someone else", () => {
    const { show, clock, maria, jake } = setup(60_000);
    show.claim(jake.id, 14, "mine", "en");
    show.claim(maria.id, 14, "yo quiero", "es");
    show.recordOrder("ORDER-J", jake.id, show.payable(jake.id));
    clock.advance(60_000);
    show.tick();
    expect(() => show.assertCapturable("ORDER-J")).toThrow(/next person/);
  });

  it("counts a lot rescued by the waitlist in the recap", () => {
    const { show, clock, maria, jake } = setup(60_000);
    show.claim(jake.id, 14, "mine", "en");
    show.claim(maria.id, 14, "yo quiero", "es");
    clock.advance(60_000);
    show.tick();
    show.recordOrder("ORDER-M", maria.id, show.payable(maria.id));
    show.markCaptured("ORDER-M");
    const r = show.recap();
    expect(r.rescuedLots).toBe(1);
    expect(r.rescuedCents).toBe(4000);
    expect(r.lapsedClaims).toBe(1);
  });
});

describe("rules parser", () => {
  const cases: Array<[string, string, number[] | null]> = [
    ["mine!", "claim", []],
    ["SOLD 14", "claim", [14]],
    ["14", "claim", [14]],
    ["#14 and #15", "claim", [14, 15]],
    ["yo quiero el 14", "claim", [14]],
    ["मुझे चाहिए 14", "claim", [14]],
    ["🙋 14 size M", "claim", [14]],
    ["me!", "claim", []],
    ["is 14 still available?", "question", null],
    ["can you show me the back?", "question", null],
    ["love that color", "chatter", null],
    ["not mine, my sister's", "chatter", null],
  ];
  it.each(cases)("%s → %s", (text, kind, lots) => {
    const r = readChatByRules(text);
    expect(r.kind).toBe(kind);
    if (lots && r.kind === "claim") expect(r.lotNumbers).toEqual(lots);
  });

  it("reads a size", () => {
    const r = readChatByRules("🙋 14 size M");
    expect(r.kind === "claim" && r.size).toBe("M");
  });
});
