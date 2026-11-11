// Reads a seller's YouTube Live chat with the public YouTube Data API (an API key is enough,
// no app review). Messages go into the same claim queue as the Dibs room chat.
//
// Endpoints (YouTube Data API v3):
//   videos.list?part=liveStreamingDetails&id=VIDEO   → liveStreamingDetails.activeLiveChatId
//   liveChat/messages?liveChatId=…&part=snippet,authorDetails&pageToken=…
//     → items[].snippet.displayMessage, items[].authorDetails.displayName, pollingIntervalMillis, nextPageToken

export interface YouTubeMessage {
  id: string;
  author: string;
  channelId: string;
  text: string;
  publishedAt: number;
}

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const API = "https://www.googleapis.com/youtube/v3";

/** Accepts a watch URL, a youtu.be link, a /live/ link or a bare video id. */
export function videoIdFrom(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === "youtu.be") return u.pathname.slice(1, 12) || null;
    const v = u.searchParams.get("v");
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const m = u.pathname.match(/\/(?:live|shorts|embed)\/([\w-]{11})/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export class YouTubeChat {
  private stopped = false;
  private pageToken?: string;
  private readonly seen = new Set<string>();

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: Fetch = (url) => fetch(url) as never,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async liveChatId(videoId: string): Promise<string> {
    const res = await this.fetchFn(`${API}/videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}&key=${this.apiKey}`);
    if (!res.ok) throw new Error(`YouTube said ${res.status}`);
    const body = (await res.json()) as { items?: Array<{ liveStreamingDetails?: { activeLiveChatId?: string } }> };
    const id = body.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
    if (!id) throw new Error("That video isn't live right now, or its chat is off.");
    return id;
  }

  /** One page of new messages, plus how long YouTube asks us to wait before the next page. */
  async poll(liveChatId: string): Promise<{ messages: YouTubeMessage[]; waitMs: number }> {
    const q = new URLSearchParams({ liveChatId, part: "snippet,authorDetails", maxResults: "200", key: this.apiKey });
    if (this.pageToken) q.set("pageToken", this.pageToken);
    const res = await this.fetchFn(`${API}/liveChat/messages?${q}`);
    if (!res.ok) throw new Error(`YouTube said ${res.status}`);
    const body = (await res.json()) as {
      nextPageToken?: string;
      pollingIntervalMillis?: number;
      items?: Array<{ id: string; snippet?: { displayMessage?: string; publishedAt?: string; type?: string }; authorDetails?: { displayName?: string; channelId?: string } }>;
    };
    this.pageToken = body.nextPageToken ?? this.pageToken;
    const messages: YouTubeMessage[] = [];
    for (const it of body.items ?? []) {
      if (this.seen.has(it.id) || !it.snippet?.displayMessage) continue;
      this.seen.add(it.id);
      messages.push({
        id: it.id,
        author: it.authorDetails?.displayName ?? "viewer",
        channelId: it.authorDetails?.channelId ?? it.id,
        text: it.snippet.displayMessage,
        publishedAt: Date.parse(it.snippet.publishedAt ?? "") || Date.now(),
      });
    }
    // never poll faster than YouTube asks, and never faster than once a second
    return { messages, waitMs: Math.max(1000, body.pollingIntervalMillis ?? 3000) };
  }

  /** Polls until stopped. The first page is history from before the connection and is skipped. */
  async run(videoId: string, onMessage: (m: YouTubeMessage) => void, onError: (e: Error) => void): Promise<void> {
    try {
      const chat = await this.liveChatId(videoId);
      await this.poll(chat); // backlog: claims typed before the seller connected don't count
      while (!this.stopped) {
        try {
          const { messages, waitMs } = await this.poll(chat);
          for (const m of messages) onMessage(m);
          await this.sleep(waitMs);
        } catch (e) {
          onError(e as Error);
          await this.sleep(10_000);
        }
      }
    } catch (e) {
      onError(e as Error);
    }
  }

  stop() {
    this.stopped = true;
  }
}
