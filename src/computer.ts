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
