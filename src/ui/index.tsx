// The settings page and the agent's Computer tab.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { usePluginAction, usePluginData, type PluginPageProps, type PluginSettingsPageProps, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";

const PLUGIN = "agent-computer"; // the manifest id
type Config = Record<string, unknown>;
interface Secret { id: string; name: string | null; key: string | null; status?: string; deletedAt?: string | null }
interface AgentRow { id: string; name: string; title: string | null; status: string }
interface Control { holder: "bot" | "human"; requested: boolean; reason?: string; request?: { id: string; reason?: string }; secretWanted?: string; transitioning?: boolean }
interface Screen { shot: { base64?: string; width?: number; height?: number; url?: string; error?: string }; control: Control | null }

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
      const next = { ...config!, computerUrl: String(config!.computerUrl).trim(), sites: list };
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
      <div style={s.row}>
        <button style={{ ...s.button, ...s.primary }} disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
        {note ? <span style={note.ok ? s.ok : s.bad}>{note.text}</span> : null}
      </div>
    </div>
  );
}

const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

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
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentId, setAgentId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("agent"));
  useEffect(() => {
    if (!companyId) return;
    api<AgentRow[] | { agents: AgentRow[] }>(`/api/companies/${companyId}/agents`).then((r) => (Array.isArray(r) ? r : r.agents))
      .then((list) => { const live = list.filter((a) => a.status !== "terminated"); setAgents(live); setAgentId((cur) => cur ?? live[0]?.id ?? null); })
      .catch(() => setAgents([]));
  }, [companyId]);
  const pick = (id: string) => {
    setAgentId(id);
    const u = new URL(window.location.href);
    u.searchParams.set("agent", id);
    window.history.replaceState(null, "", u);
  };
  if (!companyId) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,220px) minmax(0,1fr)", gap: 20, padding: 16 }}>
      <div style={{ display: "grid", gap: 4, alignContent: "start" }}>
        <div style={{ ...s.label, marginBottom: 6 }}>Agents</div>
        {agents.map((a) => (
          <button key={a.id} onClick={() => pick(a.id)} style={{ ...s.button, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", ...(a.id === agentId ? { borderColor: "#2f6fed" } : { borderColor: "transparent" }) }}>{a.name}</button>
        ))}
      </div>
      {agentId ? <LiveView key={agentId} companyId={companyId} agentId={agentId} /> : <div style={s.help}>No agents.</div>}
    </div>
  );
}

/** One agent's browser, live: refreshed a few times a second, with take over, hand back and passwords. */
function LiveView({ companyId, agentId }: { companyId: string; agentId: string }) {
  const screen = usePluginAction("screen");
  const control = usePluginAction("control");
  const input = usePluginAction("input");
  const secret = usePluginAction("secret");
  const [view, setView] = useState<Screen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const img = useRef<HTMLImageElement>(null);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      while (live) {
        if (document.visibilityState === "visible") {
          try { setView((await screen({ companyId, agentId })) as Screen); setError(null); } catch (e) { setError(errText(e)); }
        }
        await new Promise((r) => setTimeout(r, document.visibilityState === "visible" ? 300 : 2000));
      }
    };
    void tick();
    return () => { live = false; };
  }, [companyId, agentId]);

  const c = view?.control;
  const mine = c?.holder === "human";
  const send = (params: Record<string, unknown>) => input({ companyId, agentId, ...params }).catch((e) => setFlash(errText(e)));
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setFlash(null); try { await fn(); } catch (e) { setFlash(errText(e)); } finally { setBusy(false); } };

  const at = (e: { clientX: number; clientY: number }) => {
    const el = img.current;
    if (!el || !view?.shot.width) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) / r.width) * view.shot.width), y: Math.round(((e.clientY - r.top) / r.height) * (view.shot.height ?? 800)) };
  };

  return (
    <div style={{ display: "grid", gap: 12, maxWidth: 1100, minWidth: 0 }}>
      <div style={s.row}>
        <span style={{ ...s.help, opacity: 0.85 }}>{view?.shot.url ? view.shot.url : "No page open yet"}</span>
        <span style={{ flex: 1 }} />
        {mine ? (
          <button style={{ ...s.button, ...s.primary }} disabled={busy} onClick={() => run(() => control({ companyId, agentId, op: "release", requestId: c?.request?.id }))}>Hand back to the agent</button>
        ) : c?.requested && c.request ? (
          <>
            <button style={{ ...s.button, ...s.primary }} disabled={busy} onClick={() => run(() => control({ companyId, agentId, op: "take", requestId: c.request!.id }))}>Take over</button>
            <button style={s.button} disabled={busy} onClick={() => run(() => control({ companyId, agentId, op: "cancel", requestId: c.request!.id }))}>Decline</button>
          </>
        ) : (
          <button style={s.button} disabled={busy || !view} onClick={() => run(() => control({ companyId, agentId, op: "take" }))}>Take over</button>
        )}
      </div>
      {c?.requested && !mine ? <div style={s.warn}><b>The agent is asking for help:</b> {c.request?.reason ?? c.reason ?? "it is stuck"}. Take over, do what it needs, then hand back.</div> : null}
      {c?.secretWanted ? (
        <div style={s.warn}>
          <div style={{ marginBottom: 8 }}><b>The agent needs your {c.secretWanted}.</b> It goes straight into the field on the page; the agent never sees it.</div>
          <div style={s.row}>
            <input style={{ ...s.input, maxWidth: 320 }} type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={c.secretWanted} />
            <button style={{ ...s.button, ...s.primary }} disabled={busy || !password} onClick={() => run(async () => { await secret({ companyId, agentId, text: password }); setPassword(""); setFlash("Entered."); })}>Enter it</button>
          </div>
        </div>
      ) : null}
      {mine ? <div style={s.help}>You have the browser. Click on the page and type; the agent waits until you hand it back.</div> : null}
      {flash ? <div style={flash === "Entered." ? s.ok : s.bad}>{flash}</div> : null}
      {error ? <div style={s.bad}>{error}</div> : null}
      {view?.shot.base64 ? (
        <img
          ref={img}
          src={`data:image/png;base64,${view.shot.base64}`}
          alt="The agent's browser"
          tabIndex={mine ? 0 : -1}
          draggable={false}
          style={{ width: "100%", borderRadius: 8, border: `2px solid ${mine ? "#2f6fed" : "rgba(127,127,127,.3)"}`, cursor: mine ? "pointer" : "default", outline: "none" }}
          onClick={(e) => { if (!mine) return; e.currentTarget.focus(); const p = at(e); if (p) void send({ kind: "click", ...p }); }}
          onWheel={(e) => { if (mine) void send({ kind: "scroll", deltaY: Math.round(e.deltaY) }); }}
          onKeyDown={(e) => {
            if (!mine || e.metaKey || e.ctrlKey) return;
            if (e.key.length === 1) { e.preventDefault(); void send({ kind: "type", text: e.key }); }
            else if (KEYS.has(e.key)) { e.preventDefault(); void send({ kind: "key", key: e.key }); }
          }}
        />
      ) : view?.shot.error ? <div style={s.help}>The browser is not running yet ({view.shot.error}). It starts when the agent first opens a page, or when you take over.</div> : <div style={s.help}>Loading the screen…</div>}
    </div>
  );
}
