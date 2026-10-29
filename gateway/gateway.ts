// The live screen's way in. The browser cannot hold the computer's token, so the Computers page
// asks the plugin for a ticket (agent, expiry, HMAC signature) and opens a websocket here; this
// checks the ticket and pipes the socket to the computer's /stream with the token added. The
// computer itself refuses input unless a person holds the browser. Run with Bun.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

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
type Data = { agent: string; mode: "view" | "drive"; pending?: string; inFlight: number };
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
      if (frame) shared.last = data;
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
  fetch(req) {
    const url = new URL(req.url);
    if (!bearer(req)) return new Response("Not authorised.", { status: 401 });
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
