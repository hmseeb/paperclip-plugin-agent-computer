import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { handle } from "./actions.ts";
import { Computer } from "./computer.ts";
import { HELP } from "./help.ts";

let ctx: PluginContext;
const errText = (err: unknown) => String((err as Error)?.message ?? err);
// Every company's settings, kept so a worker restarted without a config replay still serves them.
const BOOT = { scopeKind: "instance" as const, namespace: "computer", stateKey: "boot" };
const HUMAN = { click: "/human/click", type: "/human/type", key: "/human/key", scroll: "/human/scroll" } as const;

interface Tenant { computer: Computer; sites: Map<string, string[]> }
const tenants = new Map<string, Tenant>();

async function start(companyId: string, config: Record<string, unknown>): Promise<Tenant | null> {
  const url = typeof config.computerUrl === "string" ? config.computerUrl.trim() : "";
  if (!url || !config.computerToken) { tenants.delete(companyId); return null; }
  const token = await ctx.secrets.resolve(config.computerToken as string, { companyId, configPath: "computerToken" });
  const sites = new Map<string, string[]>();
  for (const s of Array.isArray(config.sites) ? (config.sites as { agentId?: string; sites?: string[] }[]) : []) {
    if (s?.agentId && Array.isArray(s.sites)) sites.set(s.agentId, s.sites);
  }
  const t = { computer: new Computer(url, token), sites };
  tenants.set(companyId, t);
  return t;
}

async function tenant(companyId: string): Promise<Tenant | null> {
  if (tenants.has(companyId)) return tenants.get(companyId)!;
  const saved = ((await ctx.state.get(BOOT)) as Record<string, Record<string, unknown>> | null)?.[companyId];
  return saved ? start(companyId, saved) : null;
}

/** An agent of this company, or an error: UI calls name the agent, and the host only checks the company. */
async function agentOf(companyId: string, agentId: unknown): Promise<{ id: string; name: string }> {
  const a = typeof agentId === "string" ? await ctx.agents.get(agentId, companyId) : null;
  if (!a) throw new Error("No such agent in this company.");
  return a;
}

async function ensureSkill(companyId: string): Promise<string | null> {
  let r = await ctx.skills.managed.reconcile("computer", companyId);
  if (r.skill && r.defaultDrift?.changedFiles.length) r = await ctx.skills.managed.reset("computer", companyId);
  return r.skill?.key ?? null;
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

    // The Computer tab. Only people: an agent calling these could watch or steer another agent's browser.
    const person = (context: { actor: { type: string } }) => {
      if (context.actor.type !== "user") throw new Error("Only people can use the Computers page.");
    };
    const forTab = async (params: Record<string, unknown>) => {
      const companyId = String(params.companyId ?? "");
      const t = await tenant(companyId);
      if (!t) throw new Error("The agent computer is not set up for this company (plugin settings).");
      const agent = await agentOf(companyId, params.agentId);
      return { t, agent, companyId };
    };
    ctx.actions.register("screen", async (params, context) => {
      person(context);
      const { t, agent } = await forTab(params);
      const [shot, control] = await Promise.all([
        t.computer.call<{ base64?: string; width?: number; height?: number; url?: string }>(agent.id, "GET", "/screenshot", undefined, 20_000).catch((err) => ({ error: errText(err) })),
        t.computer.call(agent.id, "GET", "/control", undefined, 10_000).catch(() => null),
      ]);
      return { shot, control };
    });
    ctx.actions.register("control", async (params, context) => {
      person(context);
      const { t, agent } = await forTab(params);
      const op = String(params.op);
      if (op === "take" && !params.requestId) {
        // A person stepping in unasked: open a request on the agent's behalf, then take it.
        const req = await t.computer.call<{ request?: { id?: string } }>(agent.id, "POST", "/control/request", { reason: "A person stepped in from Paperclip." });
        return t.computer.call(agent.id, "POST", "/control/take", { requestId: req.request?.id });
      }
      if (!["take", "release", "cancel"].includes(op)) throw new Error("Unknown control action.");
      return t.computer.call(agent.id, "POST", `/control/${op}`, { requestId: String(params.requestId ?? "") });
    });
    ctx.actions.register("input", async (params, context) => {
      person(context);
      const { t, agent } = await forTab(params);
      const path = HUMAN[String(params.kind) as keyof typeof HUMAN];
      if (!path) throw new Error("Unknown input.");
      const { x, y, text, key, deltaY } = params;
      return t.computer.call(agent.id, "POST", path, { x, y, text, key, deltaY }, 20_000);
    });
    // A password for the field the agent pointed at. Typed into the page and dropped: never logged, stored or returned.
    ctx.actions.register("secret", async (params, context) => {
      person(context);
      const { t, agent } = await forTab(params);
      if (typeof params.text !== "string" || !params.text) throw new Error("Type the value first.");
      const r = await t.computer.call<{ supplied?: boolean; characters?: number }>(agent.id, "POST", "/human/secret", { text: params.text }, 30_000);
      return { supplied: r.supplied === true, characters: r.characters };
    });
  },

  async onApiRequest(input) {
    const agentId = input.actor.agentId;
    if (input.actor.actorType !== "agent" || !agentId) return { status: 403, body: { error: "Only agents call these routes." } };
    if (input.routeKey === "help") return { status: 200, body: HELP };
    const t = await tenant(input.companyId);
    if (!t) return { status: 503, body: { error: "The agent computer is not set up for your company yet." } };
    const query = Object.fromEntries(Object.entries(input.query).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    const body = input.body && typeof input.body === "object" && !Array.isArray(input.body) ? (input.body as Record<string, unknown>) : {};
    const res = await handle({
      computer: t.computer,
      sites: (id) => t.sites.get(id) ?? [],
      needsPerson: async (id, kind, reason, url) => {
        const agent = await ctx.agents.get(id, input.companyId).catch(() => null);
        const company = await ctx.companies.get(input.companyId).catch(() => null);
        // The Mattermost plugin listens for this and posts a Take over link: its Paperclip URL + `path`.
        const path = company?.issuePrefix ? `/${company.issuePrefix}/computer?agent=${id}` : null;
        await ctx.events.emit("needs-person", input.companyId, { agentId: id, agentName: agent?.name ?? null, kind, reason, url, path })
          .catch((err) => ctx.logger.warn("could not announce a help request", { err: errText(err) }));
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
