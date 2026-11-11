import { describe, expect, it } from "vitest";
import { YouTubeChat, videoIdFrom } from "../src/server/youtube.js";
import { Room } from "../src/server/room.js";
import { Ai } from "../src/server/ai/gemini.js";

const VID = "dQw4w9WgXcQ";

/** A scripted YouTube API: first a video lookup, then pages of chat. */
function fakeYouTube(pages: Array<Array<{ id: string; who: string; ch: string; text: string }>>, opts: { live?: boolean; interval?: number } = {}) {
  const calls: string[] = [];
  let page = 0;
  const fetchFn = async (url: string) => {
    calls.push(url);
    if (url.includes("/videos?")) {
      return { ok: true, status: 200, json: async () => ({ items: [{ liveStreamingDetails: opts.live === false ? {} : { activeLiveChatId: "CHAT1" } }] }) };
    }
    const items = (pages[page] ?? []).map((m) => ({ id: m.id, snippet: { displayMessage: m.text, publishedAt: new Date().toISOString() }, authorDetails: { displayName: m.who, channelId: m.ch } }));
    page++;
    return { ok: true, status: 200, json: async () => ({ items, nextPageToken: `P${page}`, pollingIntervalMillis: opts.interval ?? 0 }) };
  };
  return { fetchFn, calls };
}

describe("YouTube links", () => {
  it.each([
    [`https://www.youtube.com/watch?v=${VID}`, VID],
    [`https://youtu.be/${VID}`, VID],
    [`https://www.youtube.com/live/${VID}?si=abc`, VID],
    [VID, VID],
    ["https://example.com/watch?v=nope", null],
  ])("%s → %s", (input, id) => expect(videoIdFrom(input)).toBe(id));
});

describe("YouTube chat reader", () => {
  it("finds the live chat and pages through it without repeats", async () => {
    const { fetchFn, calls } = fakeYouTube([
      [{ id: "a", who: "Maria", ch: "UC1", text: "mine" }],
      [{ id: "a", who: "Maria", ch: "UC1", text: "mine" }, { id: "b", who: "Jake", ch: "UC2", text: "sold 1" }],
    ]);
    const yt = new YouTubeChat("KEY", fetchFn);
    expect(await yt.liveChatId(VID)).toBe("CHAT1");
    expect((await yt.poll("CHAT1")).messages.map((m) => m.id)).toEqual(["a"]);
    const second = await yt.poll("CHAT1");
    expect(second.messages.map((m) => m.id)).toEqual(["b"]);
    expect(second.waitMs).toBeGreaterThanOrEqual(1000); // never faster than once a second
    expect(calls[2]).toContain("pageToken=P1");
  });

  it("says so when the video isn't live", async () => {
    const { fetchFn } = fakeYouTube([], { live: false });
    await expect(new YouTubeChat("KEY", fetchFn).liveChatId(VID)).rejects.toThrow(/isn't live/);
  });
});

describe("claims from YouTube", () => {
  async function run(pages: Parameters<typeof fakeYouTube>[0]) {
    const room = new Room(60_000, new Ai(undefined, "none"));
    room.show.openLot({ number: 1, title: "Denim jacket", priceCents: 4000 });
    const { fetchFn } = fakeYouTube(pages);
    let ticks = 0;
    const yt = new YouTubeChat("KEY", fetchFn, async () => {
      if (++ticks > pages.length) yt.stop();
    });
    room.connectYouTube(`https://youtu.be/${VID}`, "KEY", yt);
    await new Promise((r) => setTimeout(r, 30));
    return room;
  }

  it("ignores the backlog and queues new claims in order", async () => {
    const room = await run([
      [{ id: "old", who: "Early", ch: "UC0", text: "mine" }], // typed before the seller connected
      [{ id: "1", who: "Maria", ch: "UC1", text: "mine!!" }, { id: "2", who: "Jake", ch: "UC2", text: "sold 1" }],
    ]);
    expect(room.show.holder(1)?.handle).toBe("Maria");
    expect(room.show.waitlist(1).map((c) => c.handle)).toEqual(["Jake"]);
    expect(room.show.chat.some((m) => m.handle === "Early")).toBe(false);
    expect(room.show.chat.find((m) => m.handle === "Maria")?.source).toBe("youtube");
  });

  it("lets a YouTube viewer pay only with the code the seller reads out", async () => {
    const room = await run([[], [{ id: "1", who: "Maria", ch: "UC1", text: "mine" }]]);
    const maria = room.show.holder(1)!;
    const code = room.show.claimCodes()[maria.buyerId]!;
    expect(code).toMatch(/^\d{4}$/);
    expect(JSON.stringify(room.show.snapshot())).not.toContain(`"${code}"`);
    expect(room.show.redeemCode(code === "9999" ? "1000" : "9999")).toBeUndefined();
    const session = room.show.redeemCode(code)!;
    expect(session.id).toBe(maria.buyerId);
    expect(room.show.buyerByToken(session.token)?.handle).toBe("Maria");
    expect(room.show.payable(session.id)).toHaveLength(1);
  });

  it("stops guessing after too many wrong codes", () => {
    const room = new Room(60_000, new Ai(undefined, "none"));
    room.show.joinExternal("youtube", "UC1", "Maria");
    const real = Object.values(room.show.claimCodes())[0]!;
    let wrong = 1000;
    for (let i = 0; i < 20; i++) {
      if (String(wrong) === real) wrong++;
      room.show.redeemCode(String(wrong++));
    }
    expect(() => room.show.redeemCode(real)).toThrow(/Too many/);
  });
});
