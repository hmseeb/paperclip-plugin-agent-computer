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

export function validTicket(key: Buffer, agent: string, exp: string, sig: string, now = Date.now() / 1000): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(agent) || !/^\d{10}$/.test(exp)) return false;
  const e = Number(exp);
  if (e < now || e > now + MAX_AGE_S) return false;
  const want = createHmac("sha256", key).update(`${agent}.${exp}`).digest("hex");
  return sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

/**
 * Flow control per viewer: the page acknowledges every frame it draws, and at most `WINDOW` frames
 * are unacknowledged at once. A newer frame replaces the one waiting (`pending`). Without this the
 * frames queued up inside the tunnel, out of sight of any buffer check here, and the screen trailed
 * a scroll by seconds; now it is at most one round trip behind.
 */
type Data = { agent: string; pending?: string; inFlight: number };
type Client = Bun.ServerWebSocket<Data>;

/**
 * One stream per agent, shared. The computer serves one viewer per agent and drops the older one,
 * so a second tab used to take the screen from the first; here every tab watches the same socket.
 * A still page sends no frames, so the latest one is replayed to whoever joins.
 */
interface Shared { upstream: WebSocket; clients: Set<Client>; last?: string; queue: string[] }
const streams = new Map<string, Shared>();

/**
 * What people did in each browser, for the plugin to turn into how-tos. The computer's recorder
 * describes a gesture (which element, which page) and never what was typed; the stream is opened
 * with a recording id so it does. Kept two hours, in memory.
 */
const steps = new Map<string, { at: number }[]>();
const KEEP_MS = 2 * 60 * 60_000;
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
    const shared: Shared = { upstream, clients: new Set(), queue: [] };
    upstream.onopen = () => { for (const m of shared.queue.splice(0)) upstream.send(m); };
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
  if (s.last) { ws.data.inFlight++; ws.send(s.last); }
}

function leave(ws: Client) {
  const s = streams.get(ws.data.agent);
  if (!s) return;
  s.clients.delete(ws);
  if (!s.clients.size) {
    streams.delete(ws.data.agent);
    s.upstream.close();
  }
}

Bun.serve<Data>({
  port: Number(process.env.PORT ?? 4200),
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/_computer/health") return new Response("ok");
    // The plugin reading recorded steps. Public path, so it needs the computer's own token.
    if (url.pathname === "/_computer/steps") {
      if (!bearer(req)) return new Response("Not authorised.", { status: 401 });
      const since = Number(url.searchParams.get("since") ?? 0);
      const list = (steps.get(url.searchParams.get("agent") ?? "") ?? []).filter((x) => x.at >= since);
      return Response.json({ steps: list });
    }
    if (url.pathname !== "/_computer/stream") return new Response("Not found", { status: 404 });
    const agent = url.searchParams.get("agent") ?? "";
    if (!validTicket(KEY, agent, url.searchParams.get("exp") ?? "", url.searchParams.get("sig") ?? "")) {
      return new Response("This link has expired. Reload the page.", { status: 403 });
    }
    if (server.upgrade(req, { data: { agent, inFlight: 0 } })) return undefined;
    return new Response("Expected a websocket.", { status: 400 });
  },
  websocket: {
    maxPayloadLength: 4 * 1024 * 1024,
    open: join,
    // Input from any tab; the computer accepts it only while a person holds the browser.
    message(ws, m) {
      const s = streams.get(ws.data.agent);
      if (!s) return;
      const text = typeof m === "string" ? m : m.toString();
      if (text === '{"type":"ack"}') {
        ws.data.inFlight = Math.max(0, ws.data.inFlight - 1);
        const p = ws.data.pending;
        if (p) { ws.data.pending = undefined; ws.data.inFlight++; ws.send(p); }
        return;
      }
      if (s.upstream.readyState === WebSocket.OPEN) s.upstream.send(text);
      else if (s.queue.length < 50) s.queue.push(text);
    },
    close: leave,
  },
});
