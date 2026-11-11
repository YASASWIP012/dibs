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

import { maskForTranslation, unmaskTranslation } from "../src/server/ai/gemini.js";
import { checkRefund } from "../src/server/ai/cohost.js";

describe("rules parser, more languages", () => {
  const more: Array<[string, string, number[]]> = [
    ["je prends le 16 taille M", "fr", [16]],
    ["ich nehme 4", "de", [4]],
    ["eu quero o 2", "pt", [2]],
    ["2番ください", "ja", [2]],
    ["我要 7", "zh", [7]],
  ];
  it.each(more)("%s → claim in %s", (text, lang, lots) => {
    const r = readChatByRules(text);
    expect(r.kind).toBe("claim");
    if (r.kind === "claim") {
      expect(r.lang).toBe(lang);
      expect(r.lotNumbers).toEqual(lots);
    }
  });
});

describe("translation guard", () => {
  it("keeps prices, handles and times out of the model's hands", () => {
    const { masked, kept } = maskForTranslation("@kenji lot 2 is $28. Pay within 0:40.");
    expect(masked).not.toContain("$28");
    expect(kept).toEqual(["@kenji", "2", "$28", "0:40"]);
    const back = unmaskTranslation(masked.replace("is", "es"), kept);
    expect(back).toBe("@kenji lot 2 es $28. Pay within 0:40.");
  });
  it("rejects a translation that changed or dropped an amount", () => {
    const { kept } = maskForTranslation("lot 2 is $28");
    expect(unmaskTranslation("lote [[0]] es ¥4,200", kept)).toBeNull();
  });
});

describe("hold release and refunds", () => {
  it("lets the seller end an unpaid hold early", () => {
    const { show, maria, jake } = setup();
    show.claim(jake.id, 14, "mine", "en");
    show.claim(maria.id, 14, "yo quiero", "es");
    show.releaseHold(14);
    expect(show.holder(14)?.handle).toBe("maria");
  });

  it("only allows refunds of paid lots, up to what was captured", () => {
    const { show, jake } = setup();
    show.claim(jake.id, 14, "mine", "en");
    expect(checkRefund(show, 14, 1000).ok).toBe(false);
    show.recordOrder("O-1", jake.id, show.payable(jake.id));
    show.markCaptured("O-1", "CAP-1");
    expect(checkRefund(show, 14, 5000)).toMatchObject({ ok: false });
    expect(checkRefund(show, 14, 0)).toMatchObject({ ok: false });
    expect(checkRefund(show, 14, 2500)).toMatchObject({ ok: true, captureId: "CAP-1" });
    show.recordRefund("CAP-1", 2500, "R-1");
    show.recordRefund("CAP-1", 2500, "R-1"); // same refund reported twice
    expect(checkRefund(show, 14, 2000)).toMatchObject({ ok: false });
    expect(checkRefund(show, 14, 1500)).toMatchObject({ ok: true });
  });
});

describe("per-lot refund cap", () => {
  it("won't refund the same lot twice inside a two-lot order", () => {
    const { show, jake } = setup();
    show.openLot({ number: 15, title: "Pothos cutting", priceCents: 2500 });
    show.claim(jake.id, 14, "14", "en");
    show.claim(jake.id, 15, "15", "en");
    show.recordOrder("O-2", jake.id, show.payable(jake.id));
    show.markCaptured("O-2", "CAP-2");
    expect(checkRefund(show, 15, 2500)).toMatchObject({ ok: true });
    show.recordRefund("CAP-2", 2500, "R-15", 15);
    expect(checkRefund(show, 15, 2500)).toMatchObject({ ok: false });
    expect(checkRefund(show, 14, 4000)).toMatchObject({ ok: true });
  });
});

describe("phrasing from a real YouTube live sale", () => {
  // read from the public chat of a live fabric sale on 11 Nov 2026, names dropped
  const real: Array<[string, string]> = [
    ["hold rkh do booking meri confrm h", "claim"],
    ["kya rate h", "question"],
    ["Delhi ki shipping kya hai mam", "question"],
    ["price plz", "question"],
    ["khadi me double bed ki dikha dijiye", "question"],
    ["welcome dear", "chatter"],
  ];
  it.each(real)("%s → %s", (text, kind) => expect(readChatByRules(text).kind).toBe(kind));
});
