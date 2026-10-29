// The agent computer: OpenBot's MIT container (github.com/CopilotKit/openbot, agent-computer/),
// one Chromium per agent, saved logins per agent. Every call names the agent as the bot it is
// for, so agents never share a browser. Only the plugin holds the token.

export type Egress = { mode: "allow_all" | "allowlist_only"; rules: { type: "domain"; value: string }[] };

export class ComputerError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error ?? `computer answered ${status}`));
    this.status = status;
    this.body = body;
  }
}

export class Computer {
  private base: string;
  private token: string;
  private fetchImpl: typeof fetch;
  /** The proxy each computer's traffic goes out through (settings), or null for the host's own connection. */
  private upstream: (bot: string) => string | null;

  constructor(base: string, token: string, fetchImpl: typeof fetch = fetch, upstream: (bot: string) => string | null = () => null) {
    this.base = base.replace(/\/+$/, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.upstream = upstream;
  }

  async call<T = Record<string, unknown>>(agentId: string, method: "GET" | "POST" | "PUT", path: string, body?: unknown, timeoutMs = 90_000): Promise<T> {
    const r = await this.fetchImpl(this.base + path, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "x-openbot-bot-id": agentId, "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let json: Record<string, unknown>;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text.slice(0, 300) }; }
    if (!r.ok) throw new ComputerError(r.status, json);
    return json as T;
  }

  /** Which sites a computer may reach, and through which proxy; the computer blocks everything until told. */
  egress(agentId: string, policy: Egress) {
    return this.call(agentId, "PUT", "/egress-policy", { policy, upstream: this.upstream(agentId) });
  }

  health() {
    return this.call<{ status: string }>("health-check", "GET", "/health", undefined, 10_000);
  }
}

/** Sites from settings ("gohighlevel.com, *.msgsndr.com") as the computer's policy; none means open. */
export function egressFor(sites: string[] | undefined): Egress {
  const domains = (sites ?? []).map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean);
  return domains.length ? { mode: "allowlist_only", rules: domains.map((value) => ({ type: "domain", value })) } : { mode: "allow_all", rules: [] };
}

/** What the address bar opens: an address as typed, anything else searched on Google. */
export function addressFor(input: string): string {
  const v = input.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (!/\s/.test(v) && /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/.*)?$/i.test(v)) return `https://${v}`;
  return `https://www.google.com/search?q=${encodeURIComponent(v)}`;
}

export type ProxyCheck = { ok: true; ip: string; ms: number } | { ok: false; error: string; ms: number };

/**
 * Whether a proxy works: connect to it, ask it for a tunnel to a "what is my address" service, and
 * read the address the world sees. HTTP proxies (and HTTPS ones); the password goes only to the proxy.
 */
export async function checkProxy(proxyUrl: string, target = { host: "api.ipify.org", port: 443, tls: true }, timeoutMs = 15_000, allowLocal = false): Promise<ProxyCheck> {
  const { connect, BlockList, isIP } = await import("node:net");
  const { lookup } = await import("node:dns/promises");
  const tls = await import("node:tls");
  const started = Date.now();
  const fail = (error: string): ProxyCheck => ({ ok: false, error, ms: Date.now() - started });
  let u: URL;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(proxyUrl.trim()) ? proxyUrl.trim() : `http://${proxyUrl.trim()}`); } catch { return fail("That is not a proxy address (http://user:password@host:port)."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") return fail(`${u.protocol.replace(":", "")} proxies are not supported; use an HTTP proxy address.`);
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  // Not this machine, link-local (cloud metadata) or carrier-grade NAT: a test that could reach those
  // would let anyone with the settings page probe the server. A proxy on the private network is fine.
  if (!allowLocal) {
    const banned = new BlockList();
    for (const [a, p, f] of [["127.0.0.0", 8, "ipv4"], ["169.254.0.0", 16, "ipv4"], ["100.64.0.0", 10, "ipv4"], ["0.0.0.0", 8, "ipv4"], ["::1", 128, "ipv6"], ["fe80::", 10, "ipv6"], ["fd00:ec2::254", 128, "ipv6"]] as const) banned.addSubnet(a, p, f);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((x) => x.address);
    const mapped = (a: string) => /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a)?.[1] ?? a;
    if (addrs.some((a) => banned.check(mapped(a), isIP(mapped(a)) === 6 ? "ipv6" : "ipv4"))) return fail("That address is not allowed for a proxy.");
  }
  return new Promise<ProxyCheck>((resolve) => {
    let done = false;
    const finish = (r: ProxyCheck) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); resolve(r); };
    const timer = setTimeout(() => finish(fail(`No answer within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
    const sock = u.protocol === "https:" ? tls.connect({ host: u.hostname, port, servername: u.hostname }) : connect(port, u.hostname);
    sock.once("error", (e: Error & { code?: string }) => finish(fail(e.code === "ENOTFOUND" ? `The proxy's host "${u.hostname}" was not found.` : e.code === "ECONNREFUSED" ? "The proxy refused the connection (wrong host or port?)." : `Could not reach the proxy: ${e.message}`)));
    sock.once(u.protocol === "https:" ? "secureConnect" : "connect", () => {
      const auth = u.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")}\r\n` : "";
      sock.write(`CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n${auth}\r\n`);
    });
    let head = Buffer.alloc(0);
    const onHead = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      sock.off("data", onHead);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString())?.[1] ?? 0);
      if (status === 407) return finish(fail("The proxy refused the username or password."));
      if (status !== 200) return finish(fail(`The proxy would not open a connection (answered ${status || "something unexpected"}).`));
      const pipe = target.tls ? tls.connect({ socket: sock, servername: target.host }) : sock;
      let body = "";
      pipe.once("error", (e: Error) => finish(fail(`Connected to the proxy, but not through it: ${e.message}`)));
      pipe.on("data", (d: Buffer) => {
        body += d.toString();
        const m = /\r\n\r\n([\s\S]*)$/.exec(body);
        const ip = m?.[1].trim().match(/^[0-9a-f.:]+$/i)?.[0];
        if (ip) finish({ ok: true, ip, ms: Date.now() - started });
      });
      pipe.write(`GET / HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
    };
    sock.on("data", onHead);
  });
}
