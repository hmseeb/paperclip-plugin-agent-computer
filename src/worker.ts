import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { createHmac } from "node:crypto";
import { handle, type Target, type HowTo } from "./actions.ts";
import { addressFor, Computer, egressFor } from "./computer.ts";
import { HELP } from "./help.ts";
import { Leases, mayUse, sharedComputers, summarize, type Demonstration, type SharedComputer, type Step } from "./learning.ts";

let ctx: PluginContext;
const errText = (err: unknown) => String((err as Error)?.message ?? err);
// Every company's settings, kept so a worker restarted without a config replay still serves them.
const BOOT = { scopeKind: "instance" as const, namespace: "computer", stateKey: "boot" };
const DEMO_FRESH_MS = 24 * 60 * 60_000;

interface Tenant {
  computer: Computer;
  token: string;
  gatewayUrl: string;
  sites: Map<string, string[]>;
  shared: SharedComputer[];
  leases: Leases;
  ticketKey: Buffer;
  /** When a person took each browser, and what they did with the browser chrome since. */
  takenAt: Map<string, number>;
  chrome: Map<string, Step[]>;
  /** Open help and password requests, for the overlay, and when each computer was last used by its agent. */
  pending: Map<string, { agentId: string; agentName: string; computer: string | null; kind: string; reason: string; at: number }>;
  lastUsed: Map<string, number>;
}
const tenants = new Map<string, Tenant>();

async function start(companyId: string, config: Record<string, unknown>): Promise<Tenant | null> {
  const url = typeof config.computerUrl === "string" ? config.computerUrl.trim() : "";
  if (!url || !config.computerToken) { tenants.delete(companyId); return null; }
  const token = await ctx.secrets.resolve(config.computerToken as string, { companyId, configPath: "computerToken" });
  const sites = new Map<string, string[]>();
  for (const s of Array.isArray(config.sites) ? (config.sites as { agentId?: string; sites?: string[] }[]) : []) {
    if (s?.agentId && Array.isArray(s.sites)) sites.set(s.agentId, s.sites);
  }
  const old = tenants.get(companyId);
  const t: Tenant = {
    computer: new Computer(url, token), token, sites, shared: sharedComputers(config),
    gatewayUrl: (typeof config.gatewayUrl === "string" && config.gatewayUrl.trim()) || "http://agent-computer-gateway:4200",
    // Leases and takeovers survive a settings save.
    leases: old?.leases ?? new Leases(), takenAt: old?.takenAt ?? new Map(), chrome: old?.chrome ?? new Map(),
    pending: old?.pending ?? new Map(), lastUsed: old?.lastUsed ?? new Map(),
    // Signs live-screen tickets; gateway/gateway.ts derives the same key from the same token.
    ticketKey: createHmac("sha256", token).update("agent-computer stream tickets").digest(),
  };
  tenants.set(companyId, t);
  return t;
}

async function tenant(companyId: string): Promise<Tenant | null> {
  if (tenants.has(companyId)) return tenants.get(companyId)!;
  const saved = ((await ctx.state.get(BOOT)) as Record<string, Record<string, unknown>> | null)?.[companyId];
  return saved ? start(companyId, saved) : null;
}

const store = (companyId: string) => {
  const key = (stateKey: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "computer", stateKey });
  return {
    get: async <T,>(k: string) => (await ctx.state.get(key(k))) as T | null,
    set: (k: string, v: unknown) => ctx.state.set(key(k), v),
  };
};

async function ensureSkill(companyId: string): Promise<string | null> {
  let r = await ctx.skills.managed.reconcile("computer", companyId);
  if (r.skill && r.defaultDrift?.changedFiles.length) r = await ctx.skills.managed.reset("computer", companyId);
  return r.skill?.key ?? null;
}

const findShared = (t: Tenant, name: string) => {
  const n = name.trim().toLowerCase();
  return t.shared.find((b) => b.id === n || b.name.toLowerCase() === n);
};

/** What a person did in a browser from taking it until now: the recorder's steps plus the chrome. */
async function demonstration(t: Tenant, bot: string, reason: string): Promise<Demonstration | null> {
  const from = t.takenAt.get(bot);
  if (!from) return null;
  const recorded = await fetch(`${t.gatewayUrl}/_computer/steps?agent=${encodeURIComponent(bot)}&since=${from}`, {
    headers: { authorization: `Bearer ${t.token}` }, signal: AbortSignal.timeout(5000),
  }).then((r) => (r.ok ? r.json() as Promise<{ steps: Step[] }> : { steps: [] })).catch(() => ({ steps: [] as Step[] }));
  const steps = summarize([...recorded.steps, ...(t.chrome.get(bot) ?? []).filter((s) => s.at >= from)]);
  t.takenAt.delete(bot);
  t.chrome.delete(bot);
  return steps.length ? { from, to: Date.now(), reason, steps } : null;
}

const plugin = definePlugin({
  multiCompanyConfig: true,

  async setup(c) {
    ctx = c;
    ctx.data.register("setup", async (params) => {
      const companyId = String(params.companyId ?? "");
      const t = await tenant(companyId).catch(() => null);
      if (!t) return { connected: false, status: "Not set up: fill in the computer URL and token, then save." };
      const h = await t.computer.health().then(() => "Connected to the computer.").catch((err) => `Cannot reach the computer: ${errText(err)}`);
      return { connected: h.startsWith("Connected"), status: h };
    });
    ctx.actions.register("skill", async (params) => ({ key: await ensureSkill(String(params.companyId)) }));
    // A new version's skill text reaches the companies already set up, without waiting for a settings save.
    setTimeout(() => {
      void ctx.state.get(BOOT).then((all) => Promise.all(Object.keys((all as Record<string, unknown> | null) ?? {}).map((id) => ensureSkill(id))))
        .catch((err) => ctx.logger.warn("could not refresh the Agent computer skill", { err: errText(err) }));
    }, 15_000);

    // The Computers page. Only people: an agent calling these could watch or steer another agent's browser.
    const person = (context: { actor: { type: string } }) => {
      if (context.actor.type !== "user") throw new Error("Only people can use the Computers page.");
    };
    /** The browser a page call names: an agent of this company, or one of its shared browsers. */
    const forTab = async (params: Record<string, unknown>) => {
      const companyId = String(params.companyId ?? "");
      const t = await tenant(companyId);
      if (!t) throw new Error("The agent computer is not set up for this company (plugin settings).");
      const id = typeof params.agentId === "string" ? params.agentId : "";
      const shared = t.shared.find((b) => b.id === id);
      if (shared) return { t, bot: shared.id, sites: shared.sites, companyId };
      const agent = id ? await ctx.agents.get(id, companyId) : null;
      if (!agent) throw new Error("No such agent or shared computer in this company.");
      return { t, bot: agent.id, sites: t.sites.get(agent.id) ?? [], companyId };
    };
    ctx.actions.register("computers", async (params, context) => {
      person(context);
      const companyId = String(params.companyId ?? "");
      const t = await tenant(companyId);
      const agents = (await ctx.agents.list({ companyId, limit: 500 })).filter((a) => a.status !== "terminated");
      const name = (id: string | null) => (id ? agents.find((a) => a.id === id)?.name ?? "an agent" : null);
      return {
        agents: agents.map((a) => ({ id: a.id, name: a.name })),
        shared: (t?.shared ?? []).map((b) => ({ id: b.id, name: b.name, inUseBy: name(t!.leases.holder(b.id)) })),
      };
    });
    // The overlay on every page: computers waiting for a person, and the one of the agent being chatted with.
    ctx.actions.register("attention", async (params, context) => {
      person(context);
      const companyId = String(params.companyId ?? "");
      const t = await tenant(companyId);
      if (!t) return { pending: [], active: null };
      // Asked of every computer, so a request made before a restart still shows. A cheap local read each.
      const agents = (await ctx.agents.list({ companyId, limit: 500 })).filter((x) => x.status !== "terminated");
      const nameOf = (id: string | null) => agents.find((x) => x.id === id)?.name ?? "An agent";
      const bots = [...agents.map((x) => ({ bot: x.id, agentId: x.id, computer: null as string | null })),
        ...t.shared.map((b) => ({ bot: b.id, agentId: t.leases.holder(b.id), computer: b.name }))];
      const waiting = (await Promise.all(bots.map(async (b) => {
        const c = await t.computer.call<{ holder?: string; requested?: boolean; secretWanted?: string; request?: { reason?: string; createdAt?: string } }>(b.bot, "GET", "/control", undefined, 3000).catch(() => null);
        // A request a person has not taken yet, or a password field waiting for them.
        if (!c || !(c.secretWanted || (c.requested && c.holder !== "human"))) return null;
        const known = t.pending.get(b.bot);
        return { bot: b.bot, agentName: known?.agentName ?? nameOf(b.agentId), computer: b.computer, kind: c.secretWanted ? "password" : "help",
          reason: c.secretWanted ? `needs your ${c.secretWanted}` : c.request?.reason ?? known?.reason ?? "needs a person", at: Date.parse(c.request?.createdAt ?? "") || known?.at || 0 };
      }))).filter((x): x is NonNullable<typeof x> => x !== null);
      let active: { bot: string; agentName: string } | null = null;
      const ref = typeof params.chat === "string" ? params.chat.toLowerCase() : "";
      if (ref) {
        const a = agents.find((x) => x.id === ref || (x as { urlKey?: string }).urlKey?.toLowerCase() === ref);
        const used = a ? t.lastUsed.get(a.id) ?? 0 : 0;
        if (a && Date.now() - used < 3 * 60_000) active = { bot: a.id, agentName: a.name };
      }
      return { pending: waiting.sort((x, y) => y.at - x.at), active };
    });
    ctx.actions.register("howtos", async (params, context) => {
      person(context);
      const { companyId } = await forTab(params);
      return (await store(companyId).get<HowTo[]>(`howtos:${String(params.agentId)}`)) ?? [];
    });
    // What the page polls: who has the browser and which page it is on. The picture comes from the stream.
    ctx.actions.register("state", async (params, context) => {
      person(context);
      const { t, bot } = await forTab(params);
      const [control, tabs] = await Promise.all([
        t.computer.call(bot, "GET", "/control", undefined, 10_000).catch(() => null),
        t.computer.call<{ tabs?: { index: number; url: string; title: string; active: boolean }[] }>(bot, "GET", "/tabs", undefined, 15_000).then((r) => r.tabs ?? []).catch(() => []),
      ]);
      const active = tabs.find((x) => x.active);
      return { control, tabs, url: active?.url ?? null, title: active?.title ?? null };
    });
    // A person taking the browser: from then on their steps are recorded, until they hand it back.
    const hold = async (t: Tenant, bot: string, sites: string[]) => {
      // The computer blocks every site until it has this browser's policy, and a person may be first.
      await t.computer.egress(bot, egressFor(sites));
      const c = await t.computer.call<{ holder?: string; requested?: boolean; request?: { id?: string } }>(bot, "GET", "/control");
      if (c.holder === "human") return;
      const id = c.requested && c.request?.id ? c.request.id
        : (await t.computer.call<{ request?: { id?: string } }>(bot, "POST", "/control/request", { reason: "A person stepped in from Paperclip." })).request?.id;
      await t.computer.call(bot, "POST", "/control/take", { requestId: id ?? "" });
      t.takenAt.set(bot, Date.now());
    };
    const chromeStep = (t: Tenant, bot: string, step: Step) => {
      const list = t.chrome.get(bot) ?? [];
      list.push(step);
      t.chrome.set(bot, list.slice(-500));
    };
    ctx.actions.register("control", async (params, context) => {
      person(context);
      const { t, bot, sites, companyId } = await forTab(params);
      const op = String(params.op);
      if (op === "take") {
        if (params.requestId) {
          await t.computer.egress(bot, egressFor(sites));
          const r = await t.computer.call(bot, "POST", "/control/take", { requestId: String(params.requestId) });
          t.takenAt.set(bot, Date.now());
          return r;
        }
        await hold(t, bot, sites);
        return t.computer.call(bot, "GET", "/control");
      }
      if (op === "release") {
        // Saved before the browser goes back, so an agent waiting on /pc/wait gets it with "done".
        const c = await t.computer.call<{ request?: { reason?: string } }>(bot, "GET", "/control").catch(() => ({} as { request?: { reason?: string } }));
        const demo = await demonstration(t, bot, c.request?.reason ?? "A person stepped in.").catch(() => null);
        if (demo) await store(companyId).set(`demo:${bot}`, { ...demo, seenBy: [] });
      }
      if (!["release", "cancel"].includes(op)) throw new Error("Unknown control action.");
      return t.computer.call(bot, "POST", `/control/${op}`, { requestId: String(params.requestId ?? "") });
    });
    // A ticket for the live screen: the gateway at /_computer/stream checks it and adds the token.
    ctx.actions.register("stream-ticket", async (params, context) => {
      person(context);
      const { t, bot } = await forTab(params);
      const exp = String(Math.floor(Date.now() / 1000) + 60);
      const sig = createHmac("sha256", t.ticketKey).update(`${bot}.${exp}`).digest("hex");
      return { path: `/_computer/stream?agent=${bot}&exp=${exp}&sig=${sig}` };
    });
    // The browser chrome: address bar, back, forward, reload and tabs. They act as the person, so a
    // person who does not hold the browser yet takes it first, as they would to click on the page.
    ctx.actions.register("goto", async (params, context) => {
      person(context);
      const { t, bot, sites } = await forTab(params);
      const url = typeof params.url === "string" ? params.url.trim() : "";
      if (!url) throw new Error("Type an address.");
      await hold(t, bot, sites);
      const r = await t.computer.call<{ url?: string }>(bot, "POST", "/human/navigate", { url: addressFor(url) });
      chromeStep(t, bot, { at: Date.now(), kind: "open", url: r.url ?? addressFor(url) });
      return r;
    });
    ctx.actions.register("history", async (params, context) => {
      person(context);
      const { t, bot, sites } = await forTab(params);
      await hold(t, bot, sites);
      const action = String(params.action);
      const r = await t.computer.call(bot, "POST", "/human/history", { action });
      if (action === "back" || action === "forward" || action === "reload") chromeStep(t, bot, { at: Date.now(), kind: action });
      return r;
    });
    ctx.actions.register("tab", async (params, context) => {
      person(context);
      const { t, bot, sites } = await forTab(params);
      await hold(t, bot, sites);
      const action = String(params.action);
      const index = typeof params.index === "number" ? params.index : undefined;
      if (action === "close") {
        // Closing the last tab leaves a blank one, as a browser window would, rather than refusing.
        const { tabs } = await t.computer.call<{ tabs: unknown[] }>(bot, "GET", "/tabs");
        if (tabs.length <= 1) await t.computer.call(bot, "POST", "/human/tabs", { action: "new" });
      }
      const r = await t.computer.call<{ url?: string }>(bot, "POST", "/human/tabs", { action, index });
      chromeStep(t, bot, { at: Date.now(), kind: action === "new" ? "new-tab" : action === "close" ? "close-tab" : "switch-tab", url: r.url });
      return r;
    });
    // A password for the field the agent pointed at. Typed into the page and dropped: never logged, stored or returned.
    ctx.actions.register("secret", async (params, context) => {
      person(context);
      const { t, bot } = await forTab(params);
      if (typeof params.text !== "string" || !params.text) throw new Error("Type the value first.");
      const r = await t.computer.call<{ supplied?: boolean; characters?: number }>(bot, "POST", "/human/secret", { text: params.text }, 30_000);
      return { supplied: r.supplied === true, characters: r.characters };
    });
  },

  async onApiRequest(input) {
    const agentId = input.actor.agentId;
    if (input.actor.actorType !== "agent" || !agentId) return { status: 403, body: { error: "Only agents call these routes." } };
    if (input.routeKey === "help") return { status: 200, body: HELP };
    const companyId = input.companyId;
    const t = await tenant(companyId);
    if (!t) return { status: 503, body: { error: "The agent computer is not set up for your company yet." } };
    const s = store(companyId);
    const agents = () => ctx.agents.list({ companyId, limit: 500 });
    const nameOf = async (id: string | null) => (id ? (await ctx.agents.get(id, companyId).catch(() => null))?.name ?? "another agent" : null);
    const query = Object.fromEntries(Object.entries(input.query).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    const body = input.body && typeof input.body === "object" && !Array.isArray(input.body) ? (input.body as Record<string, unknown>) : {};
    const res = await handle({
      computer: t.computer,
      async pick(id, name) {
        if (!name) { t.lastUsed.set(id, Date.now()); return { bot: id, label: "your computer", sites: t.sites.get(id) ?? [], shared: false }; }
        const b = findShared(t, name);
        if (!b) return { status: 404, error: `There is no shared computer "${name}". /pc/computers lists yours.` };
        if (!mayUse(b, id)) return { status: 403, error: `You may not use the shared computer "${b.name}"; the board decides in the plugin settings.` };
        const lease = t.leases.take(b.id, id);
        if (!lease.ok) return { status: 409, error: `"${b.name}" is in use by ${await nameOf(lease.holder)}. Try again in a few minutes; it frees up 10 minutes after their last use.` };
        t.lastUsed.set(id, Date.now());
        return { bot: b.id, label: b.name, sites: b.sites, shared: true };
      },
      async computers(id) {
        return [{ name: "your own", shared: false, inUseBy: null },
          ...await Promise.all(t.shared.filter((b) => mayUse(b, id)).map(async (b) => ({ name: b.name, shared: true, inUseBy: await nameOf(t.leases.holder(b.id)) })))];
      },
      async release(id, name) {
        const b = findShared(t, name);
        return Boolean(b && t.leases.release(b.id, id));
      },
      needsPerson: async (id, b: Target, kind, reason, url) => {
        const agent = await ctx.agents.get(id, companyId).catch(() => null);
        const company = await ctx.companies.get(companyId).catch(() => null);
        // The Mattermost plugin listens for this and posts a Take over link: its Paperclip URL + `path`.
        const path = company?.issuePrefix ? `/${company.issuePrefix}/computer?agent=${b.bot}` : null;
        t.pending.set(b.bot, { agentId: id, agentName: agent?.name ?? "An agent", computer: b.shared ? b.label : null, kind, reason, at: Date.now() });
        await ctx.events.emit("needs-person", companyId, { agentId: id, agentName: agent?.name ?? null, computer: b.shared ? b.label : null, kind, reason, url, path })
          .catch((err) => ctx.logger.warn("could not announce a help request", { err: errText(err) }));
      },
      async takeDemonstration(bot, id) {
        const demo = await s.get<Demonstration & { seenBy: string[] }>(`demo:${bot}`);
        if (!demo || demo.seenBy.includes(id) || Date.now() - demo.to > DEMO_FRESH_MS) return null;
        await s.set(`demo:${bot}`, { ...demo, seenBy: [...demo.seenBy, id] });
        const { seenBy: _seen, ...shown } = demo;
        return shown;
      },
      howtos: {
        list: async (id) => (await s.get<HowTo[]>(`howtos:${id}`)) ?? [],
        async save(id, h) {
          const list = ((await s.get<HowTo[]>(`howtos:${id}`)) ?? []).filter((x) => x.name.toLowerCase() !== h.name.toLowerCase());
          await s.set(`howtos:${id}`, [...list, h].slice(-100));
        },
        async forget(id, name) {
          const list = (await s.get<HowTo[]>(`howtos:${id}`)) ?? [];
          const left = list.filter((x) => x.name.toLowerCase() !== name.toLowerCase());
          await s.set(`howtos:${id}`, left);
          return left.length < list.length;
        },
        async teach(id, name, to) {
          const h = ((await s.get<HowTo[]>(`howtos:${id}`)) ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase());
          const target = (await agents()).find((a) => a.status !== "terminated" && (a.id === to || a.name.toLowerCase() === to.replace(/^@/, "").toLowerCase()));
          if (!h || !target || target.id === id) return null;
          const teacher = await nameOf(id);
          const theirs = ((await s.get<HowTo[]>(`howtos:${target.id}`)) ?? []).filter((x) => x.name.toLowerCase() !== h.name.toLowerCase());
          await s.set(`howtos:${target.id}`, [...theirs, { ...h, learnedFrom: teacher ?? undefined, updatedAt: new Date().toISOString() }].slice(-100));
          return target.name;
        },
      },
    }, agentId, input.routeKey, { ...query, ...body });
    return { status: res.status, body: res.body };
  },

  async onConfigChanged(config, context) {
    const companyId = context?.companyId;
    if (!companyId) return;
    const all = ((await ctx.state.get(BOOT)) as Record<string, Record<string, unknown>> | null) ?? {};
    all[companyId] = config;
    await ctx.state.set(BOOT, all);
    await start(companyId, config).catch((err) => ctx.logger.error("agent computer settings could not be applied", { companyId, err: errText(err) }));
    void ensureSkill(companyId).catch((err) => ctx.logger.warn("could not install the Agent computer skill", { companyId, err: errText(err) }));
  },

  async onHealth() {
    if (!tenants.size) return { status: "ok", message: "No company has set up the agent computer yet." };
    const parts = await Promise.all([...tenants].map(([id, t]) => t.computer.health().then(() => "reachable").catch((err) => `${id.slice(0, 8)}: ${errText(err)}`)));
    const bad = parts.filter((p) => p !== "reachable");
    return { status: bad.length ? "degraded" : "ok", message: bad.length ? bad.join(" | ") : `computer reachable for ${parts.length} companies` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
