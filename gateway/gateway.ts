// The live screen's way in. The browser cannot hold the computer's token, so the Computers page
// asks the plugin for a ticket (agent, expiry, HMAC signature) and opens a websocket here; this
// checks the ticket and pipes the socket to the computer's /stream with the token added. The
// computer itself refuses input unless a person holds the browser. Run with Bun.
import { createHmac, timingSafeEqual } from "node:crypto";

const COMPUTER = (process.env.COMPUTER_URL ?? "http://agent-computer:4100").replace(/^http/, "ws").replace(/\/+$/, "");
const TOKEN = process.env.COMPUTER_TOKEN ?? "";
if (!TOKEN) throw new Error("COMPUTER_TOKEN is required");
export const ticketKey = (token: string) => createHmac("sha256", token).update("agent-computer stream tickets").digest();
const KEY = ticketKey(TOKEN);
const MAX_AGE_S = 120;

export function validTicket(key: Buffer, agent: string, exp: string, sig: string, now = Date.now() / 1000): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(agent) || !/^\d{10}$/.test(exp)) return false;
  const e = Number(exp);
  if (e < now || e > now + MAX_AGE_S) return false;
  const want = createHmac("sha256", key).update(`${agent}.${exp}`).digest("hex");
  return sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

type Data = { agent: string };
type Client = Bun.ServerWebSocket<Data>;

/**
 * One stream per agent, shared. The computer serves one viewer per agent and drops the older one,
 * so a second tab used to take the screen from the first; here every tab watches the same socket.
 * A still page sends no frames, so the latest one is replayed to whoever joins.
 */
interface Shared { upstream: WebSocket; clients: Set<Client>; last?: string; queue: string[] }
const streams = new Map<string, Shared>();

function join(ws: Client) {
  const agent = ws.data.agent;
  let s = streams.get(agent);
  if (!s) {
    const upstream = new WebSocket(`${COMPUTER}/stream?token=${encodeURIComponent(TOKEN)}&bot=${encodeURIComponent(agent)}`);
    const shared: Shared = { upstream, clients: new Set(), queue: [] };
    upstream.onopen = () => { for (const m of shared.queue.splice(0)) upstream.send(m); };
    upstream.onmessage = (m) => {
      const data = String(m.data);
      if (data.startsWith('{"type":"frame"')) shared.last = data;
      for (const c of shared.clients) c.send(data);
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
  if (s.last) ws.send(s.last);
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
    if (url.pathname !== "/_computer/stream") return new Response("Not found", { status: 404 });
    const agent = url.searchParams.get("agent") ?? "";
    if (!validTicket(KEY, agent, url.searchParams.get("exp") ?? "", url.searchParams.get("sig") ?? "")) {
      return new Response("This link has expired. Reload the page.", { status: 403 });
    }
    if (server.upgrade(req, { data: { agent } })) return undefined;
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
      if (s.upstream.readyState === WebSocket.OPEN) s.upstream.send(text);
      else if (s.queue.length < 50) s.queue.push(text);
    },
    close: leave,
  },
});
