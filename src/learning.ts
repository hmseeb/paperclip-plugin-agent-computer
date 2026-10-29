// What a person did in a browser, as steps an agent can follow and save as a how-to. Steps come
// from the computer's recorder (through the gateway) for input on the page, and from the plugin for
// the address bar, back, forward, reload and tabs. Nothing typed is ever recorded: a step says which
// field was typed into, and a password field is named as one.

export type Step =
  | { at: number; kind: "click" | "type" | "key" | "scroll"; key?: string; deltaY?: number; url?: string; target?: { role?: string; name?: string; sensitive?: boolean } }
  | { at: number; kind: "open" | "back" | "forward" | "reload" | "new-tab" | "switch-tab" | "close-tab"; url?: string };

export interface Demonstration {
  /** When the person took the browser and handed it back. */
  from: number;
  to: number;
  /** Why the browser was handed over: the agent's help request, or a person stepping in. */
  reason: string;
  steps: string[];
}

const host = (url?: string) => {
  try {
    const u = url ? new URL(url) : null;
    return u && /^https?:$/.test(u.protocol) ? u.host + u.pathname.replace(/\/$/, "") : "";
  } catch { return ""; }
};
const what = (t?: { role?: string; name?: string; sensitive?: boolean }) =>
  !t ? "the page" : t.sensitive ? "a password or code field" : `${t.role ?? "element"} "${t.name ?? ""}"`.replace(/ ""$/, "");

/** Readable, numbered steps: typing in one field is one step, scrolls in a row are one step. */
export function summarize(steps: Step[]): string[] {
  const out: string[] = [];
  let page = "";
  let last = "";
  const push = (line: string) => { if (line !== last) out.push(line); last = line; };
  for (const s of [...steps].sort((a, b) => a.at - b.at)) {
    const where = host(s.url);
    if (where && where !== page && s.kind !== "open") { page = where; push(`On ${where}:`); }
    switch (s.kind) {
      case "open": page = host(s.url); push(`Opened ${s.url}`); break;
      case "back": push("Went back"); break;
      case "forward": push("Went forward"); break;
      case "reload": push("Reloaded the page"); break;
      case "new-tab": push("Opened a new tab"); break;
      case "switch-tab": push(`Switched to the tab with ${s.url ?? "another page"}`); break;
      case "close-tab": push("Closed a tab"); break;
      case "click": push(`Clicked ${what(s.target)}`); break;
      case "type": push(s.target?.sensitive ? "Typed a password or code (a person's secret: ask for it with ask-for-password)" : `Typed into ${what(s.target)}`); break;
      case "key": push(`Pressed ${s.key}`); break;
      case "scroll": push(`Scrolled ${(s.deltaY ?? 0) < 0 ? "up" : "down"}`); break;
    }
  }
  // Number the actions; "On page:" lines stay as headings.
  let n = 0;
  return out.map((line) => (line.startsWith("On ") && line.endsWith(":") ? line : `${++n}. ${line}`));
}

/** `allAgents` (the default): every agent of the company, new ones included; otherwise only `agents`. */
export interface SharedComputer { id: string; name: string; allAgents: boolean; agents: string[]; sites: string[]; proxy?: string }

export const mayUse = (b: SharedComputer, agentId: string) => b.allAgents || b.agents.includes(agentId);

/** Which browser a call uses: the agent's own, or a shared one it is allowed, leased to one agent at a time. */
export class Leases {
  private held = new Map<string, { agentId: string; until: number }>();
  private ttlMs: number;
  private now: () => number;
  constructor(ttlMs = 10 * 60_000, now = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** Takes or renews the lease; returns who holds it when someone else does. */
  take(computerId: string, agentId: string): { ok: true } | { ok: false; holder: string } {
    const h = this.held.get(computerId);
    if (h && h.agentId !== agentId && h.until > this.now()) return { ok: false, holder: h.agentId };
    this.held.set(computerId, { agentId, until: this.now() + this.ttlMs });
    return { ok: true };
  }

  release(computerId: string, agentId: string): boolean {
    const h = this.held.get(computerId);
    if (!h || h.agentId !== agentId) return false;
    this.held.delete(computerId);
    return true;
  }

  holder(computerId: string): string | null {
    const h = this.held.get(computerId);
    return h && h.until > this.now() ? h.agentId : null;
  }
}

export function sharedComputers(config: Record<string, unknown>): SharedComputer[] {
  const saved = config.sharedComputers ?? config.sharedBrowsers; // the setting's name before the rename
  const list = Array.isArray(saved) ? (saved as Partial<SharedComputer>[]) : [];
  return list
    .filter((b): b is SharedComputer => typeof b?.id === "string" && /^shared-[a-z0-9-]{1,50}$/.test(b.id) && typeof b.name === "string")
    .map((b) => ({ id: b.id, name: b.name, allAgents: b.allAgents !== false, agents: Array.isArray(b.agents) ? b.agents : [], sites: Array.isArray(b.sites) ? b.sites : [], ...(typeof b.proxy === "string" && b.proxy ? { proxy: b.proxy } : {}) }));
}

/**
 * Which proxy a computer uses: its own choice (an agent's, or a shared computer's), else the default.
 * "none" is the host's own connection even when there is a default. Returns a proxy id or null.
 */
export function proxyChoice(own: string | undefined, fallback: string | undefined): string | null {
  const pick = own && own !== "default" ? own : fallback;
  return pick && pick !== "none" ? pick : null;
}

/** A person holding a computer nobody has open for this long has walked away: it goes back to the agent. */
export const ABANDONED_MS = 5 * 60_000;
/** Held this long with no record of anyone watching (the gateway restarted since): also back to the agent. */
export const ABANDONED_UNKNOWN_MS = 10 * 60_000;

/** Whether a person's hold on a computer is abandoned: nobody watching it, for long enough. */
export function abandoned(a: { heldFor: number; viewers: number; lastWatched: number | null; gatewayUp: number; now: number }): boolean {
  if (a.viewers > 0) return false;
  if (a.lastWatched !== null) return a.now - a.lastWatched > ABANDONED_MS && a.heldFor > ABANDONED_MS;
  return a.heldFor > ABANDONED_UNKNOWN_MS && a.gatewayUp > ABANDONED_MS;
}
