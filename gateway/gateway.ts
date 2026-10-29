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

type Data = { agent: string; upstream?: WebSocket; queue: (string | Buffer)[] };

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
    if (server.upgrade(req, { data: { agent, queue: [] } })) return undefined;
    return new Response("Expected a websocket.", { status: 400 });
  },
  websocket: {
    maxPayloadLength: 4 * 1024 * 1024,
    open(ws) {
      const up = new WebSocket(`${COMPUTER}/stream?token=${encodeURIComponent(TOKEN)}&bot=${encodeURIComponent(ws.data.agent)}`);
      ws.data.upstream = up;
      up.onopen = () => { for (const m of ws.data.queue.splice(0)) up.send(m); };
      up.onmessage = (m) => ws.send(m.data as string);
      up.onclose = () => ws.close();
      up.onerror = () => ws.close();
    },
    message(ws, m) {
      const up = ws.data.upstream;
      if (up?.readyState === WebSocket.OPEN) up.send(m);
      else if (ws.data.queue.length < 50) ws.data.queue.push(m);
    },
    close(ws) {
      ws.data.upstream?.close();
    },
  },
});
