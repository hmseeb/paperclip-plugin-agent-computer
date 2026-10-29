// The settings page and the agent's Computer tab.
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { LiveScreen } from "./live-screen.tsx";
import { usePluginAction, usePluginData, type PluginPageProps, type PluginSettingsPageProps, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";

const PLUGIN = "agent-computer"; // the manifest id
type Config = Record<string, unknown>;
interface Secret { id: string; name: string | null; key: string | null; status?: string; deletedAt?: string | null }
interface AgentRow { id: string; name: string; title: string | null; status: string }
interface Tab { index: number; url: string; title: string; active: boolean }
interface Control { holder: "bot" | "human"; requested: boolean; reason?: string; request?: { id: string; reason?: string }; secretWanted?: string; transitioning?: boolean }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: "include", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
  return (await r.json()) as T;
}

const s = {
  field: { display: "grid", gap: 6, marginBottom: 22 } as CSSProperties,
  label: { fontWeight: 600, fontSize: 14 } as CSSProperties,
  help: { fontSize: 12.5, opacity: 0.65, lineHeight: 1.45 } as CSSProperties,
  input: { width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 6, border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", font: "inherit" } as CSSProperties,
  row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } as CSSProperties,
  button: { padding: "7px 14px", borderRadius: 6, border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", font: "inherit", cursor: "pointer", whiteSpace: "nowrap" } as CSSProperties,
  primary: { background: "#2f6fed", borderColor: "#2f6fed", color: "white" } as CSSProperties,
  ok: { color: "#2e9e6a" } as CSSProperties,
  bad: { color: "#d24b4e" } as CSSProperties,
  warn: { padding: "10px 12px", borderRadius: 6, background: "rgba(242,169,0,.12)", border: "1px solid rgba(242,169,0,.45)" } as CSSProperties,
};

function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return <div style={s.field}><div style={s.label}>{label}</div>{children}{help ? <div style={s.help}>{help}</div> : null}</div>;
}

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

export function SettingsPage({ context }: PluginSettingsPageProps) {
  const companyId = context.companyId;
  const [config, setConfig] = useState<Config | null>(null);
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [sites, setSites] = useState<Record<string, string>>({});
  const [shared, setShared] = useState<{ id: string; name: string; allAgents: boolean; agents: string[]; sites: string }[]>([]);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const setup = usePluginData<{ connected: boolean; status: string }>("setup", { companyId });
  const skill = usePluginAction("skill");

  useEffect(() => {
    if (!companyId) return;
    Promise.all([
      api<{ configJson?: Config | null } | null>(`/api/plugins/${PLUGIN}/config?companyId=${companyId}`),
      api<Secret[]>(`/api/companies/${companyId}/secrets`).catch(() => [] as Secret[]),
      api<AgentRow[] | { agents: AgentRow[] }>(`/api/companies/${companyId}/agents`).then((r) => (Array.isArray(r) ? r : r.agents)).catch(() => [] as AgentRow[]),
    ]).then(([cfg, secs, ags]) => {
      const c = cfg?.configJson ?? {};
      setConfig({ computerUrl: "http://agent-computer:4100", ...c });
      setSecrets(secs.filter((x) => !x.deletedAt && x.status !== "deleted"));
      setAgents(ags.filter((a) => a.status !== "terminated"));
      setShared((Array.isArray(c.sharedComputers ?? c.sharedBrowsers) ? ((c.sharedComputers ?? c.sharedBrowsers) as { id: string; name: string; allAgents?: boolean; agents?: string[]; sites?: string[] }[]) : [])
        .map((b) => ({ id: b.id, name: b.name, allAgents: b.allAgents !== false, agents: b.agents ?? [], sites: (b.sites ?? []).join(", ") })));
      setSites(Object.fromEntries((Array.isArray(c.sites) ? (c.sites as { agentId: string; sites?: string[] }[]) : []).map((x) => [x.agentId, (x.sites ?? []).join(", ")])));
    }).catch((e) => setNote({ ok: false, text: `Could not load the settings: ${errText(e)}` }));
  }, [companyId]);

  if (!companyId) return <div style={s.help}>Open this page from a company to configure it.</div>;
  if (!config) return <div style={s.help}>{note?.text ?? "Loading…"}</div>;
  const set = (patch: Config) => { setNote(null); setConfig({ ...config, ...patch }); };
  const token = config.computerToken as { secretId?: string } | undefined;

  async function save() {
    if (!String(config!.computerUrl ?? "").trim() || !token?.secretId) { setNote({ ok: false, text: "Fill in the computer URL and choose the secret holding its token." }); return; }
    setSaving(true);
    setNote(null);
    try {
      const list = Object.entries(sites).map(([agentId, v]) => ({ agentId, sites: v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) })).filter((x) => x.sites.length);
      const split = (v: string) => v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
      const named = shared.filter((b) => b.name.trim());
      const dup = named.find((b, i) => named.findIndex((x) => x.name.trim().toLowerCase() === b.name.trim().toLowerCase()) !== i);
      if (dup) { setNote({ ok: false, text: `Two shared computers are called "${dup.name.trim()}"; give each its own name.` }); setSaving(false); return; }
      const sharedComputers = named.map((b) => ({ id: b.id, name: b.name.trim(), allAgents: b.allAgents, agents: b.allAgents ? [] : b.agents, sites: split(b.sites) }));
      const { sharedBrowsers: _old, ...rest } = config!;
      const next = { ...rest, computerUrl: String(config!.computerUrl).trim(), sites: list, sharedComputers };
      await api(`/api/plugins/${PLUGIN}/config`, { method: "POST", body: JSON.stringify({ companyId, configJson: next }) });
      setConfig(next);
      // Every agent gets the skill, alongside its other skills.
      const { key } = (await skill({ companyId })) as { key: string | null };
      const failed: string[] = [];
      if (key) for (const a of agents) {
        await api(`/api/agents/${a.id}/skills/sync`, { method: "POST", body: JSON.stringify({ mode: "add", desiredSkills: [key] }) }).catch(() => failed.push(a.name));
      }
      setNote(!key ? { ok: false, text: "Saved. The Agent computer skill is not installed yet; save again in a minute." }
        : failed.length ? { ok: false, text: `Saved. Could not give the skill to ${failed.join(", ")}; add it on their Skills tab.` }
        : { ok: true, text: "Saved. Every agent has the Agent computer skill." });
      setup.refresh();
    } catch (e) {
      setNote({ ok: false, text: `Could not save: ${errText(e)}` });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ ...s.help, marginBottom: 18, ...(setup.data?.connected ? s.ok : {}) }}>● {setup.data?.status ?? "Checking the computer…"}</div>
      <Field label="Computer URL" help="Where Paperclip reaches the agent computer. On the same Docker network as Paperclip this is usually http://agent-computer:4100.">
        <input style={s.input} value={String(config.computerUrl ?? "")} onChange={(e) => set({ computerUrl: e.target.value })} placeholder="http://agent-computer:4100" />
      </Field>
      <Field label="Computer token" help="A Paperclip secret holding the computer's COMPUTER_TOKEN. Only this plugin uses it; agents and people never see it.">
        <select style={s.input} value={token?.secretId ?? ""} onChange={(e) => set({ computerToken: e.target.value ? { type: "secret_ref", version: "latest", secretId: e.target.value } : undefined })}>
          <option value="">Choose a secret…</option>
          {secrets.map((x) => <option key={x.id} value={x.id}>{x.name || x.key || x.id}</option>)}
        </select>
      </Field>
      <Field label="Allowed sites" help="Leave an agent empty to let it reach any site. List sites to limit it to them, e.g. gohighlevel.com, *.msgsndr.com.">
        <div style={{ display: "grid", gap: 8 }}>
          {agents.map((a) => (
            <div key={a.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,200px) minmax(0,1fr)", gap: 10, alignItems: "center" }}>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
              <input style={s.input} value={sites[a.id] ?? ""} onChange={(e) => { setNote(null); setSites({ ...sites, [a.id]: e.target.value }); }} placeholder="Any site" />
            </div>
          ))}
        </div>
      </Field>
      <Field label="Shared computers" help="Named computers agents share, one agent at a time, for example one logged into GoHighLevel and one into LinkedIn. Add as many as you need. Log each in once from the Computers page.">
        <div style={{ display: "grid", gap: 12 }}>
          {shared.map((b, i) => {
            const edit = (patch: Partial<typeof b>) => { setNote(null); setShared(shared.map((x, j) => (j === i ? { ...x, ...patch } : x))); };
            return (
              <div key={b.id} style={{ display: "grid", gap: 8, padding: 12, borderRadius: 8, border: "1px solid rgba(127,127,127,.3)" }}>
                <div style={s.row}>
                  <input style={{ ...s.input, flex: 1 }} value={b.name} onChange={(e) => edit({ name: e.target.value })} placeholder="Name, e.g. GoHighLevel" />
                  <button style={s.button} onClick={() => { setNote(null); setShared(shared.filter((_, j) => j !== i)); }}>Remove</button>
                </div>
                <input style={s.input} value={b.sites} onChange={(e) => edit({ sites: e.target.value })} placeholder="Allowed sites (empty: any)" />
                <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="radio" checked={b.allAgents} onChange={() => edit({ allAgents: true })} />All agents (new agents included)</label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="radio" checked={!b.allAgents} onChange={() => edit({ allAgents: false })} />Only the agents I pick</label>
                </div>
                {b.allAgents ? null : <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
                  {agents.map((a) => (
                    <label key={a.id} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                      <input type="checkbox" checked={b.agents.includes(a.id)} onChange={() => edit({ agents: b.agents.includes(a.id) ? b.agents.filter((x) => x !== a.id) : [...b.agents, a.id] })} />{a.name}
                    </label>
                  ))}
                </div>}
              </div>
            );
          })}
          <div><button style={s.button} onClick={() => setShared([...shared, { id: `shared-${Math.random().toString(36).slice(2, 10)}`, name: "", allAgents: true, agents: [], sites: "" }])}>{shared.length ? "Add another shared computer" : "Add a shared computer"}</button></div>
        </div>
      </Field>
      <div style={s.row}>
        <button style={{ ...s.button, ...s.primary }} disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
        {note ? <span style={note.ok ? s.ok : s.bad}>{note.text}</span> : null}
      </div>
    </div>
  );
}


export function ComputersLink({ context }: PluginSidebarProps) {
  if (!context.companyPrefix) return null;
  const href = `/${context.companyPrefix}/computer`;
  const active = window.location.pathname.toLowerCase() === href.toLowerCase();
  // The host's own nav-item classes (SidebarNavItem), so the row matches Tasks, Projects and the rest.
  return (
    <a href={href} className={`flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors ${active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"}`}>
      <span className="relative shrink-0">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" />
        </svg>
      </span>
      <span className="min-w-0 flex-1 truncate">Computers</span>
    </a>
  );
}

/** Every agent's browser; ?agent=<id> picks one (the Mattermost Take over button links there). */
export function ComputersPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const browsers = usePluginAction("computers");
  const [list, setList] = useState<{ agents: { id: string; name: string }[]; shared: { id: string; name: string; inUseBy: string | null }[] } | null>(null);
  const [agentId, setAgentId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("agent"));
  useEffect(() => {
    if (!companyId) return;
    let live = true;
    const load = () => computers({ companyId }).then((r) => {
      if (!live) return;
      const l = r as NonNullable<typeof list>;
      setList(l);
      setAgentId((cur) => cur ?? l.agents[0]?.id ?? null);
    }).catch(() => undefined);
    void load();
    const timer = setInterval(load, 15_000); // who is using which shared computer
    return () => { live = false; clearInterval(timer); };
  }, [companyId]);
  const pick = (id: string) => {
    setAgentId(id);
    const u = new URL(window.location.href);
    u.searchParams.set("agent", id);
    window.history.replaceState(null, "", u);
  };
  if (!companyId) return null;
  const item = (id: string, label: string, sub?: string | null) => (
    <button key={id} onClick={() => pick(id)} style={{ ...s.button, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", display: "grid", ...(id === agentId ? { borderColor: "#2f6fed" } : { borderColor: "transparent" }) }}>
      <span>{label}</span>{sub ? <span style={{ ...s.help, fontSize: 11.5 }}>{sub}</span> : null}
    </button>
  );
  const isShared = Boolean(list?.shared.some((b) => b.id === agentId));
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,220px) minmax(0,1fr)", gap: 20, padding: 16 }}>
      <div style={{ display: "grid", gap: 4, alignContent: "start" }}>
        {list?.shared.length ? <>
          <div style={{ ...s.label, marginBottom: 6 }}>Shared computers</div>
          {list.shared.map((b) => item(b.id, b.name, b.inUseBy ? `in use by ${b.inUseBy}` : "free"))}
          <div style={{ height: 12 }} />
        </> : null}
        <div style={{ ...s.label, marginBottom: 6 }}>Agents</div>
        {(list?.agents ?? []).map((a) => item(a.id, a.name))}
      </div>
      {agentId ? <div style={{ display: "grid", gap: 18, alignContent: "start", minWidth: 0 }}>
        <LiveView key={agentId} companyId={companyId} agentId={agentId} />
        {isShared ? null : <HowTos key={`h-${agentId}`} companyId={companyId} agentId={agentId} />}
      </div> : <div style={s.help}>No agents.</div>}
    </div>
  );
}

/** What this agent has learned from people, as it saved it. */
function HowTos({ companyId, agentId }: { companyId: string; agentId: string }) {
  const howtos = usePluginAction("howtos");
  const [list, setList] = useState<{ name: string; site?: string; steps: string; updatedAt: string; learnedFrom?: string }[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => howtos({ companyId, agentId }).then((r) => { if (live) setList(r as never); }).catch(() => undefined);
    void load();
    const timer = setInterval(load, 20_000);
    return () => { live = false; clearInterval(timer); };
  }, [companyId, agentId]);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={s.label}>Learned how-tos</div>
      {!list?.length ? <div style={s.help}>Nothing yet. When you take over and do something, the agent gets your steps (never what you typed) and saves the ones worth keeping here.</div> : null}
      {(list ?? []).map((h) => (
        <div key={h.name} style={{ border: "1px solid rgba(127,127,127,.3)", borderRadius: 8, padding: "8px 12px" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", cursor: "pointer" }} onClick={() => setOpen(open === h.name ? null : h.name)}>
            <span style={{ fontWeight: 600 }}>{h.name}</span>
            <span style={s.help}>{[h.site, h.learnedFrom ? `taught by ${h.learnedFrom}` : null, new Date(h.updatedAt).toLocaleDateString()].filter(Boolean).join(" · ")}</span>
          </div>
          {open === h.name ? <pre style={{ whiteSpace: "pre-wrap", fontSize: 12.5, margin: "8px 0 0" }}>{h.steps}</pre> : null}
        </div>
      ))}
    </div>
  );
}

/** One agent's browser, live, with take over, hand back, an address bar and passwords. */
function LiveView({ companyId, agentId }: { companyId: string; agentId: string }) {
  const state = usePluginAction("state");
  const control = usePluginAction("control");
  const secret = usePluginAction("secret");
  const goto = usePluginAction("goto");
  const history = usePluginAction("history");
  const tab = usePluginAction("tab");
  const streamTicket = usePluginAction("stream-ticket");
  const [view, setView] = useState<{ control: Control | null; tabs: Tab[]; url: string | null; title: string | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [address, setAddress] = useState<string | null>(null); // null: follow the page
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setView((await state({ companyId, agentId })) as never); } catch (e) { setProblem(errText(e)); }
  }, [companyId, agentId]);
  useEffect(() => {
    let live = true;
    const loop = async () => {
      while (live) {
        if (document.visibilityState === "visible") await refresh();
        await new Promise((r) => setTimeout(r, 1000));
      }
    };
    void loop();
    return () => { live = false; };
  }, [refresh]);

  const ticket = useCallback(async () => ((await streamTicket({ companyId, agentId })) as { path: string }).path, [companyId, agentId]);
  const onProblem = useCallback((p: string | null) => setProblem(p), []);
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true); setFlash(null);
    try { await fn(); if (done) setFlash(done); await refresh(); } catch (e) { setFlash(errText(e)); } finally { setBusy(false); }
  };

  const c = view?.control;
  const mine = c?.holder === "human";
  const url = view?.url && view.url !== "about:blank" ? view.url : "";
  const frame: CSSProperties = { borderRadius: 10, overflow: "hidden", border: `1px solid ${mine ? "#2f6fed" : "rgba(127,127,127,.3)"}`, boxShadow: mine ? "0 0 0 2px rgba(47,111,237,.35)" : "none" };
  const chrome: CSSProperties = { border: "none", background: "transparent", color: "inherit", font: "inherit", fontSize: 16, lineHeight: 1, padding: "4px 6px", borderRadius: 6, cursor: "pointer" };
  const bar: CSSProperties = { display: "flex", gap: 8, alignItems: "center", padding: "8px 10px", background: "rgba(127,127,127,.08)" };

  return (
    <div style={{ display: "grid", gap: 10, minWidth: 0, maxWidth: 1280 }}>
      {c?.requested && !mine ? <div style={s.warn}><b>The agent is asking for help:</b> {c.request?.reason ?? c.reason ?? "it is stuck"}. Take over, do what it needs, then hand back.</div> : null}
      {c?.secretWanted ? (
        <div style={s.warn}>
          <div style={{ marginBottom: 8 }}><b>The agent needs your {c.secretWanted}.</b> It goes straight into the field on the page; the agent never sees it.</div>
          <div style={s.row}>
            <input style={{ ...s.input, maxWidth: 320 }} type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={c.secretWanted} />
            <button style={{ ...s.button, ...s.primary }} disabled={busy || !password} onClick={() => run(async () => { await secret({ companyId, agentId, text: password }); setPassword(""); }, "Entered.")}>Enter it</button>
          </div>
        </div>
      ) : null}
      <div style={frame}>
        <div style={{ display: "flex", gap: 2, alignItems: "flex-end", padding: "6px 8px 0", background: "rgba(127,127,127,.14)", overflowX: "auto" }}>
          {(view?.tabs ?? []).map((t) => (
            <div key={t.index} style={{ display: "flex", alignItems: "center", gap: 6, maxWidth: 220, minWidth: 0, padding: "6px 8px 6px 12px", borderRadius: "8px 8px 0 0", fontSize: 12.5, cursor: "pointer", background: t.active ? "rgba(127,127,127,.08)" : "transparent", opacity: t.active ? 1 : 0.7 }}
              onClick={() => { if (!t.active) void run(() => tab({ companyId, agentId, action: "select", index: t.index })); }} title={t.url}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{t.title || (t.url === "about:blank" ? "New tab" : t.url)}</span>
              <button aria-label="Close tab" title="Close tab" style={chrome} onClick={(e) => { e.stopPropagation(); void run(() => tab({ companyId, agentId, action: "close", index: t.index })); }}>×</button>
            </div>
          ))}
          <button aria-label="New tab" title="New tab" style={{ ...chrome, margin: "0 0 4px 4px" }} disabled={busy} onClick={() => run(() => tab({ companyId, agentId, action: "new" }))}>+</button>
        </div>
        <div style={bar}>
          <button aria-label="Back" title="Back" style={chrome} disabled={busy} onClick={() => run(() => history({ companyId, agentId, action: "back" }))}>←</button>
          <button aria-label="Forward" title="Forward" style={chrome} disabled={busy} onClick={() => run(() => history({ companyId, agentId, action: "forward" }))}>→</button>
          <button aria-label="Reload" title="Reload" style={chrome} disabled={busy} onClick={() => run(() => history({ companyId, agentId, action: "reload" }))}>↻</button>
          <span title={mine ? "You have the computer" : "The agent has the computer"} style={{ width: 9, height: 9, borderRadius: 9, flex: "none", background: mine ? "#2f6fed" : problem ? "#d24b4e" : "#2e9e6a" }} />
          <form style={{ flex: 1, minWidth: 0, display: "flex" }} onSubmit={(e) => { e.preventDefault(); const u = (address ?? "").trim(); if (u) void run(async () => { await goto({ companyId, agentId, url: u }); setAddress(null); }); }}>
            <input style={{ ...s.input, padding: "6px 12px", borderRadius: 999, background: "rgba(127,127,127,.08)" }} value={address ?? url}
              onFocus={(e) => { setAddress(e.target.value); e.target.select(); }} onBlur={() => setTimeout(() => setAddress(null), 300)}
              onChange={(e) => setAddress(e.target.value)} placeholder="Type a web address" />
          </form>
          {mine ? (
            <button style={{ ...s.button, ...s.primary }} disabled={busy} onClick={() => run(() => control({ companyId, agentId, op: "release", requestId: c?.request?.id }))}>Hand back</button>
          ) : c?.requested && c.request ? (
            <>
              <button style={{ ...s.button, ...s.primary }} disabled={busy} onClick={() => run(() => control({ companyId, agentId, op: "take", requestId: c.request!.id }))}>Take over</button>
              <button style={s.button} disabled={busy} onClick={() => run(() => control({ companyId, agentId, op: "cancel", requestId: c.request!.id }))}>Decline</button>
            </>
          ) : (
            <button style={s.button} disabled={busy || !view} onClick={() => run(() => control({ companyId, agentId, op: "take" }))}>Take over</button>
          )}
        </div>
        <div style={{ position: "relative", background: "rgba(127,127,127,.18)" }}>
          <LiveScreen ticket={ticket} driving={mine} onProblem={onProblem} />
          {!url && !problem ? <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#666", fontSize: 14, pointerEvents: "none" }}>Nothing open yet. Type an address above (you take over), or wait for the agent.</div> : null}
        </div>
      </div>
      <div style={{ ...s.help, minHeight: 18 }}>
        {problem ? <span style={s.bad}>{problem}</span>
          : flash ? <span style={flash === "Entered." ? s.ok : s.bad}>{flash}</span>
          : mine ? "You have the computer: click, type, scroll, drag, use shortcuts and paste. The agent waits until you hand it back."
          : view?.title ? `${view.title} · the agent has the computer. Take over to use it yourself.` : "The agent has the computer. Take over to use it yourself."}
      </div>
    </div>
  );
}
