// The live screen's way in. The browser cannot hold the computer's token, so the Computers page
// asks the plugin for a ticket (agent, expiry, HMAC signature) and opens a websocket here; this
// checks the ticket and pipes the socket to the computer's /stream with the token added. The
// computer itself refuses input unless a person holds the browser. Run with Bun.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { openable, readReplayToken, readShareToken, shareKey, type ShareMeta } from "./share-core.ts";
import { closedPage, replayPage, sharePage } from "./share-page.ts";

const COMPUTER = (process.env.COMPUTER_URL ?? "http://agent-computer:4100").replace(/^http/, "ws").replace(/\/+$/, "");
const TOKEN = process.env.COMPUTER_TOKEN ?? "";
if (!TOKEN) throw new Error("COMPUTER_TOKEN is required");
export const ticketKey = (token: string) => createHmac("sha256", token).update("agent-computer stream tickets").digest();
const KEY = ticketKey(TOKEN);
const MAX_AGE_S = 120;
const WINDOW = 2;

const MAX_PER_COMPUTER = 20;
const MAX_SOCKET_MS = 4 * 60 * 60_000; // a person removed from the company stops seeing it within this
const MAX_QUEUED_BYTES = 1024 * 1024;

/** A ticket the plugin signed for this computer, mode ("view" or "drive") and expiry. */
export function validTicket(key: Buffer, agent: string, exp: string, mode: string, sig: string, now = Date.now() / 1000): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(agent) || !/^\d{10}$/.test(exp) || (mode !== "view" && mode !== "drive")) return false;
  const e = Number(exp);
  if (e < now || e > now + MAX_AGE_S) return false;
  const want = Buffer.from(createHmac("sha256", key).update(`${agent}.${exp}.${mode}`).digest("hex"));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Each ticket opens one socket: a link copied from a log or history is already spent. */
const spent = new Map<string, number>();
function spend(sig: string, exp: number): boolean {
  const now = Date.now() / 1000;
  for (const [s, e] of spent) if (e < now) spent.delete(s);
  if (spent.has(sig)) return false;
  spent.set(sig, exp);
  return true;
}

/**
 * Flow control per viewer: the page acknowledges every frame it draws, and at most `WINDOW` frames
 * are unacknowledged at once. A newer frame replaces the one waiting (`pending`). Without this the
 * frames queued up inside the tunnel, out of sight of any buffer check here, and the screen trailed
 * a scroll by seconds; now it is at most one round trip behind.
 */
type Data = { agent: string; mode: "view" | "drive"; pending?: string; inFlight: number; /** A shared link's socket: its share id. */ share?: string };
type Client = Bun.ServerWebSocket<Data>;

/**
 * One stream per agent, shared. The computer serves one viewer per agent and drops the older one,
 * so a second tab used to take the screen from the first; here every tab watches the same socket.
 * A still page sends no frames, so the latest one is replayed to whoever joins.
 */
interface Shared { upstream: WebSocket; clients: Set<Client>; last?: string; queue: string[]; queuedBytes: number }
const streams = new Map<string, Shared>();
/** When each computer last had someone watching, for handing back computers people walked away from. */
const lastWatched = new Map<string, number>();

/**
 * What people did in each browser, for the plugin to turn into how-tos. The computer's recorder
 * describes a gesture (which element, which page) and never what was typed; the stream is opened
 * with a recording id so it does. Kept two hours, in memory.
 */
const steps = new Map<string, { at: number }[]>();
const KEEP_MS = 2 * 60 * 60_000;
const STARTED = Date.now();
function record(agent: string, action: unknown) {
  const list = steps.get(agent) ?? [];
  const now = Date.now();
  list.push({ at: now, ...(action as object) });
  while (list.length && (list.length > 2000 || list[0].at < now - KEEP_MS)) list.shift();
  steps.set(agent, list);
}
const bearer = (req: Request) => {
  const got = Buffer.from((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
};

function join(ws: Client) {
  const agent = ws.data.agent;
  let s = streams.get(agent);
  if (!s) {
    const upstream = new WebSocket(`${COMPUTER}/stream?token=${encodeURIComponent(TOKEN)}&bot=${encodeURIComponent(agent)}&recording=${randomUUID()}`);
    const shared: Shared = { upstream, clients: new Set(), queue: [], queuedBytes: 0 };
    upstream.onopen = () => { for (const m of shared.queue.splice(0)) upstream.send(m); shared.queuedBytes = 0; };
    upstream.onmessage = (m) => {
      const data = String(m.data);
      if (data.startsWith('{"type":"demonstration.action"')) {
        try { record(agent, JSON.parse(data).action); } catch { /* malformed: skip */ }
        return;
      }
      const frame = data.startsWith('{"type":"frame"');
      if (frame) { shared.last = data; recordFrame(agent, data); }
      for (const c of shared.clients) {
        if (!frame) c.send(data);
        else if (c.data.inFlight >= WINDOW) c.data.pending = data;
        else { c.data.inFlight++; c.send(data); }
      }
    };
    const end = () => {
      if (streams.get(agent) === shared) streams.delete(agent);
      for (const c of shared.clients) c.close();
    };
    upstream.onclose = end;
    upstream.onerror = end;
    streams.set(agent, shared);
    s = shared;
  }
  s.clients.add(ws);
  lastWatched.set(agent, Date.now());
  setTimeout(() => ws.close(4000, "Reload the page to keep watching."), MAX_SOCKET_MS);
  if (s.last) { ws.data.inFlight++; ws.send(s.last); }
}

function leave(ws: Client) {
  lastWatched.set(ws.data.agent, Date.now());
  const s = streams.get(ws.data.agent);
  if (!s) return;
  s.clients.delete(ws);
  if (!s.clients.size) {
    streams.delete(ws.data.agent);
    s.upstream.close();
  }
}

// Public (the tunnel or proxy routes /_computer/ here): the live screen and a health check only.
Bun.serve<Data>({
  port: Number(process.env.PORT ?? 4200),
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/_computer/health") return new Response("ok");
    if (url.pathname.startsWith("/_computer/s/")) return sharedLink(req, url, server);
    if (url.pathname.startsWith("/_computer/r/")) return replay(url);
    if (url.pathname !== "/_computer/stream") return new Response("Not found", { status: 404 });
    const q = (k: string) => url.searchParams.get(k) ?? "";
    const agent = q("agent"), exp = q("exp"), mode = q("mode") || "drive", sig = q("sig");
    if (!validTicket(KEY, agent, exp, mode, sig) || !spend(sig, Number(exp))) {
      return new Response("This link has expired. Reload the page.", { status: 403 });
    }
    if ((streams.get(agent)?.clients.size ?? 0) >= MAX_PER_COMPUTER) return new Response("Too many people are watching this computer.", { status: 429 });
    if (server.upgrade(req, { data: { agent, mode: mode as "view" | "drive", inFlight: 0 } })) return undefined;
    return new Response("Expected a websocket.", { status: 400 });
  },
  websocket: {
    maxPayloadLength: 256 * 1024, // input only: keys, clicks, a pasted block of text
    open: join,
    // Input from any tab; the computer accepts it only while a person holds the browser.
    message(ws, m) {
      const s = streams.get(ws.data.agent);
      if (!s) return;
      const text = typeof m === "string" ? m : m.toString();
      if (ws.data.mode === "view" && text !== '{"type":"ack"}') return; // the corner card only watches
      if (ws.data.share && shares.get(ws.data.share)?.status !== "active" && text !== '{"type":"ack"}') return;
      if (text === '{"type":"ack"}') {
        ws.data.inFlight = Math.max(0, ws.data.inFlight - 1);
        const p = ws.data.pending;
        if (p) { ws.data.pending = undefined; ws.data.inFlight++; ws.send(p); }
        return;
      }
      if (s.upstream.readyState === WebSocket.OPEN) s.upstream.send(text);
      else if (s.queue.length < 50 && s.queuedBytes + text.length <= MAX_QUEUED_BYTES) { s.queue.push(text); s.queuedBytes += text.length; }
    },
    close: leave,
  },
});

// Internal (the Docker network only, never routed from outside): what people did and who is
// watching, for the plugin, which presents the computer's token.
Bun.serve({
  port: Number(process.env.INTERNAL_PORT ?? 4201),
  async fetch(req) {
    const url = new URL(req.url);
    if (!bearer(req)) return new Response("Not authorised.", { status: 401 });
    if (url.pathname.startsWith("/_computer/shares")) return shareAdmin(req, url);
    if (url.pathname === "/_computer/watching") {
      const out: Record<string, { viewers: number; lastWatched: number | null }> = {};
      for (const agent of new Set([...streams.keys(), ...lastWatched.keys()])) {
        out[agent] = { viewers: streams.get(agent)?.clients.size ?? 0, lastWatched: lastWatched.get(agent) ?? null };
      }
      return Response.json({ computers: out, since: STARTED });
    }
    if (url.pathname === "/_computer/steps") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const list = (steps.get(url.searchParams.get("agent") ?? "") ?? []).filter((x) => x.at >= since);
      return Response.json({ steps: list });
    }
    return new Response("Not found", { status: 404 });
  },
});

/* ------------------------------------ shared links ------------------------------------ */
// A browser lent through a link to someone outside (gateway/share-core.ts). The plugin creates a
// share, pushes it here and signs its link; this serves the link's page, hands the browser to the
// person while they use it, records what the screen shows, and tells the plugin what happened.

const SHARE_KEY = shareKey(TOKEN);
const HTTP = COMPUTER.replace(/^ws/, "http");
const DIR = (process.env.RECORDINGS_DIR ?? "/recordings").replace(/\/+$/, "");
const KEEP_DAYS = Number(process.env.RECORDING_DAYS) || 30;
const shares = new Map<string, ShareMeta>();
const shareEvents: { id: string; kind: "opened" | "done" | "ended"; at: number }[] = [];
let writable = false;

async function computer<T = Record<string, unknown>>(bot: string, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(HTTP + path, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-openbot-bot-id": bot, "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}), signal: AbortSignal.timeout(20_000),
  });
  const json = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(json.error ?? `the computer answered ${r.status}`);
  return json;
}

type Control = { holder?: string; requested?: boolean; request?: { id?: string } };
/** The person on the link holds the browser while the share is active; the computer refuses the agent meanwhile. */
async function holdForPerson(bot: string): Promise<void> {
  const c = await computer<Control>(bot, "GET", "/control");
  if (c.holder === "human") return;
  const id = c.requested && c.request?.id ? c.request.id
    : (await computer<Control>(bot, "POST", "/control/request", { reason: "Shared through a link with someone outside the company." })).request?.id;
  await computer(bot, "POST", "/control/take", { requestId: id ?? "" });
}
async function handBack(bot: string): Promise<void> {
  const c = await computer<Control>(bot, "GET", "/control").catch(() => null);
  if (c?.holder === "human") await computer(bot, "POST", "/control/release", { requestId: c.request?.id ?? "" }).catch(() => undefined);
}

async function loadShares() {
  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(`${DIR}/.writable`, "");
    writable = true;
  } catch { console.warn(`shared links: ${DIR} is not writable, so shares are kept in memory and nothing is recorded`); }
  const saved = await readFile(`${DIR}/shares.json`, "utf8").then((t) => JSON.parse(t) as ShareMeta[]).catch(() => []);
  for (const s of saved) shares.set(s.id, s);
}
let saving: Promise<void> = Promise.resolve();
function saveShares() {
  if (!writable) return;
  saving = saving.then(() => writeFile(`${DIR}/shares.json`, JSON.stringify([...shares.values()]))).catch(() => undefined);
}
function event(id: string, kind: "opened" | "done" | "ended") {
  shareEvents.push({ id, kind, at: Date.now() });
  while (shareEvents.length > 1000) shareEvents.shift();
}
const shareOfBot = (bot: string) => { for (const s of shares.values()) if (s.bot === bot) return s; return undefined; };

/** Tell a share's open sockets its status changed: input stops; an ended share closes them. */
function announce(s: ShareMeta) {
  const stream = streams.get(s.bot);
  for (const c of stream?.clients ?? []) {
    if (c.data.share !== s.id) continue;
    if (s.status === "ended") c.close(4001, "This shared browser has ended.");
    else { if (s.status !== "active") c.data.mode = "view"; c.send('{"type":"status"}'); }
  }
}

function endShare(s: ShareMeta) {
  if (s.status === "ended") return;
  s.status = "ended";
  s.endedAt = Date.now();
  event(s.id, "ended");
  announce(s);
  saveShares();
}

/** At most one frame a second per share, only when the screen changes (Chrome sends frames only then). */
const lastSaved = new Map<string, number>();
function recordFrame(bot: string, data: string) {
  if (!writable || !bot.startsWith("share-")) return;
  const s = shareOfBot(bot);
  if (!s || s.status === "ended") return;
  const now = Date.now();
  if (now - (lastSaved.get(s.id) ?? 0) < 1000) return;
  lastSaved.set(s.id, now);
  let b64: string;
  try { b64 = (JSON.parse(data) as { data: string }).data; } catch { return; }
  void mkdir(`${DIR}/${s.id}`, { recursive: true }).then(() => writeFile(`${DIR}/${s.id}/${now}.jpg`, Buffer.from(b64, "base64"))).catch(() => undefined);
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });

function shareFor(raw: string): ShareMeta | { error: string; status: number } {
  const t = readShareToken(SHARE_KEY, raw);
  if (!t) return { error: "This link is not valid or has expired.", status: 403 };
  const s = shares.get(t.id);
  if (!s || s.exp !== t.exp) return { error: "This shared browser is not available.", status: 404 };
  if (s.status === "ended") return { error: "This shared browser has ended. You can close this page.", status: 410 };
  return s;
}

async function sharedLink(req: Request, url: URL, server: Bun.Server<Data>): Promise<Response | undefined> {
  const [, , , token = "", action = ""] = url.pathname.split("/");
  const s = shareFor(token);
  const isError = "error" in s;
  if (!action) return isError ? html(closedPage(s.error), s.status) : html(sharePage());
  if (isError) return json({ error: s.error }, s.status);
  if (action === "info") {
    return json({ title: s.title, mode: s.mode, exp: s.exp, status: s.status,
      allow: s.allow.map((p) => ({ label: p.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""), url: openable(p) })) });
  }
  if (action === "stream") {
    if (s.status === "active") {
      await holdForPerson(s.bot).catch((err) => console.warn("shared link: could not hand the browser to the person", s.id, String(err)));
      if (!s.openedAt) { s.openedAt = Date.now(); event(s.id, "opened"); saveShares(); }
    }
    if ((streams.get(s.bot)?.clients.size ?? 0) >= MAX_PER_COMPUTER) return new Response("Too many viewers.", { status: 429 });
    if (server.upgrade(req, { data: { agent: s.bot, mode: s.status === "active" ? "drive" : "view", inFlight: 0, share: s.id } })) return undefined;
    return new Response("Expected a websocket.", { status: 400 });
  }
  if (req.method !== "POST") return json({ error: "Not found." }, 404);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (action === "size") {
    if (s.status !== "active") return json({ ok: false });
    return json(await computer(s.bot, "POST", "/viewport", { width: body.width, height: body.height }).catch((err) => ({ error: String(err) })));
  }
  if (action === "go") {
    if (s.status !== "active" || typeof body.url !== "string") return json({ error: "Not now." }, 409);
    try {
      await holdForPerson(s.bot);
      return json(await computer(s.bot, "POST", "/human/navigate", { url: body.url }));
    } catch (err) { return json({ error: String((err as Error).message ?? err) }, 502); }
  }
  if (action === "done") {
    if (s.status === "active") {
      s.status = "done";
      s.doneAt = Date.now();
      event(s.id, "done");
      await handBack(s.bot); // a "login" share: the agent carries on in this browser
      announce(s);
      saveShares();
    }
    return json({ status: s.status });
  }
  return json({ error: "Not found." }, 404);
}

async function replay(url: URL): Promise<Response> {
  const [, , , token = "", action = "", name = ""] = url.pathname.split("/");
  const t = readReplayToken(SHARE_KEY, token);
  if (!t) return action ? json({ error: "Not available." }, 403) : html(closedPage("This recording link is not valid or has expired."), 403);
  if (!action) return html(replayPage());
  if (action === "frames") {
    const frames = (await readdir(`${DIR}/${t.id}`).catch(() => [] as string[])).filter((f) => /^\d{13}\.jpg$/.test(f)).sort();
    return json({ frames, title: shares.get(t.id)?.title ?? null });
  }
  if (action === "f" && /^\d{13}\.jpg$/.test(name)) {
    const file = Bun.file(`${DIR}/${t.id}/${name}`);
    return (await file.exists()) ? new Response(file, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } }) : json({ error: "No such frame." }, 404);
  }
  return json({ error: "Not found." }, 404);
}

/** For the plugin (internal port): push shares, end them, read what happened and what was recorded. */
async function shareAdmin(req: Request, url: URL): Promise<Response> {
  const parts = url.pathname.split("/"); // ["", "_computer", "shares", id?, action?]
  if (parts[3] === "events" && req.method === "GET") {
    const since = Number(url.searchParams.get("since") ?? 0);
    return json({ events: shareEvents.filter((e) => e.at > since), since: STARTED });
  }
  const id = parts[3] ?? "";
  if (!/^[a-z2-7]{12}$/.test(id)) return json({ error: "No such share." }, 404);
  if (req.method === "PUT" && !parts[4]) {
    const b = (await req.json().catch(() => null)) as Partial<ShareMeta> | null;
    if (!b || typeof b.bot !== "string" || typeof b.exp !== "number" || !Array.isArray(b.allow)) return json({ error: "bot, exp and allow are required." }, 400);
    const had = shares.get(id);
    const s: ShareMeta = {
      id, bot: b.bot, exp: b.exp, mode: b.mode === "lend" ? "lend" : "login", title: String(b.title ?? "").slice(0, 120),
      allow: b.allow.filter((x): x is string => typeof x === "string").slice(0, 100), start: String(b.start ?? ""),
      // What happened on the link is known here; the plugin's word wins only to end it.
      status: had?.status === "ended" ? "ended" : b.status === "ended" ? "ended" : had?.status ?? "active",
      createdAt: had?.createdAt ?? b.createdAt ?? Date.now(), openedAt: had?.openedAt, doneAt: had?.doneAt, endedAt: had?.endedAt,
    };
    shares.set(id, s);
    if (s.status === "ended" && had?.status !== "ended") { s.status = "active"; endShare(s); }
    saveShares();
    return json(s);
  }
  const s = shares.get(id);
  if (!s) return json({ error: "No such share." }, 404);
  if (req.method === "POST" && parts[4] === "end") { endShare(s); return json(s); }
  if (req.method === "GET" && parts[4] === "recording") {
    const frames = (await readdir(`${DIR}/${id}`).catch(() => [] as string[])).filter((f) => /^\d{13}\.jpg$/.test(f)).sort();
    return json({ frames: frames.length, from: frames.length ? Number(frames[0].slice(0, 13)) : null, to: frames.length ? Number(frames.at(-1)!.slice(0, 13)) : null });
  }
  if (req.method === "GET" && !parts[4]) return json(s);
  return json({ error: "Not found." }, 404);
}

/** Recordings and ended shares older than KEEP_DAYS go; a share past its link's expiry ends. */
async function sweep() {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const s of shares.values()) {
    if (s.status !== "ended" && s.exp * 1000 < Date.now()) endShare(s);
    if (s.status === "ended" && (s.endedAt ?? 0) < cutoff) shares.delete(s.id);
  }
  if (writable) {
    for (const d of await readdir(DIR).catch(() => [] as string[])) {
      if (!/^[a-z2-7]{12}$/.test(d)) continue;
      const st = await stat(`${DIR}/${d}`).catch(() => null);
      if (st && st.mtimeMs < cutoff && !shares.has(d)) await rm(`${DIR}/${d}`, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  saveShares();
}
await loadShares();
setInterval(() => void sweep(), 10 * 60_000);
void sweep();
