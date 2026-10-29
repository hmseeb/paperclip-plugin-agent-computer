// The settings page and the agent's Computer tab.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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

type ProxyResult = { ok: true; ip: string; ms: number } | { ok: false; error: string; ms: number };
const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

/** A proxy choice: the default, the host's own connection, or one of the named proxies. */
function ProxyPick({ value, onChange, proxies, withDefault = true }: { value: string; onChange: (v: string) => void; proxies: { id: string; name: string }[]; withDefault?: boolean }) {
  return (
    <select style={{ ...s.input, width: "auto", minWidth: 150 }} value={value} onChange={(e) => onChange(e.target.value)}>
      {withDefault ? <option value="default">Default proxy</option> : null}
      <option value="none">No proxy</option>
      {proxies.filter((p) => p.name.trim()).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
}

export function SettingsPage({ context }: PluginSettingsPageProps) {
  const companyId = context.companyId;
  const [config, setConfig] = useState<Config | null>(null);
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [sites, setSites] = useState<Record<string, string>>({});
  /** `url`: a pasted address not saved yet; `check`: its last test (for a saved one the plugin's own checks show). */
  type ProxyRow = { id: string; name: string; secretId: string; url: string; check?: ProxyResult | null; testing?: boolean };
  const [proxies, setProxies] = useState<ProxyRow[]>([]);
  const testProxy = usePluginAction("test-proxy");
  const [defaultProxy, setDefaultProxy] = useState("none");
  const [proxyFallback, setProxyFallback] = useState<"direct" | "stop">("direct");
  const [agentProxies, setAgentProxies] = useState<Record<string, string>>({});
  const [shared, setShared] = useState<{ id: string; name: string; allAgents: boolean; agents: string[]; sites: string; proxy?: string }[]>([]);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const setup = usePluginData<{ connected: boolean; status: string; versionNote?: string | null; proxies?: Record<string, (ProxyResult & { at: number }) | null> }>("setup", { companyId });
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
        .map((b) => ({ id: b.id, name: b.name, allAgents: b.allAgents !== false, agents: b.agents ?? [], sites: (b.sites ?? []).join(", "), proxy: (b as { proxy?: string }).proxy })));
      setProxies((Array.isArray(c.proxies) ? (c.proxies as { id: string; name?: string; url?: { secretId?: string } }[]) : []).map((x) => ({ id: x.id, name: x.name ?? "", secretId: x.url?.secretId ?? "", url: "" })));
      setDefaultProxy(typeof c.defaultProxy === "string" ? c.defaultProxy : "none");
      setProxyFallback(c.proxyFallback === "stop" ? "stop" : "direct");
      setAgentProxies((c.agentProxies && typeof c.agentProxies === "object" ? c.agentProxies : {}) as Record<string, string>);
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
      const sharedComputers = named.map((b) => ({ id: b.id, name: b.name.trim(), allAgents: b.allAgents, agents: b.allAgents ? [] : b.agents, sites: split(b.sites), ...(b.proxy && b.proxy !== "default" ? { proxy: b.proxy } : {}) }));
      // Proxies: a pasted URL is tested first, and saved only if it works, as a Paperclip secret.
      const bad = proxies.find((p) => !p.name.trim() || (!p.secretId && !p.url.trim()));
      if (bad) { setNote({ ok: false, text: "Give every proxy a name and paste its URL, or remove it." }); setSaving(false); return; }
      const rows = [...proxies];
      for (const [i, p] of rows.entries()) {
        if (!p.url.trim()) continue;
        const check = (await testProxy({ companyId, url: p.url })) as ProxyResult;
        rows[i] = { ...p, check };
        if (!check.ok) { setProxies(rows); setNote({ ok: false, text: `Not saved: the proxy "${p.name.trim()}" does not work (${check.error}). Fix its URL or remove it.` }); setSaving(false); return; }
        if (p.secretId) await api(`/api/secrets/${p.secretId}/rotate`, { method: "POST", body: JSON.stringify({ value: p.url.trim() }) });
        else {
          const made = await api<{ id: string }>(`/api/companies/${companyId}/secrets`, { method: "POST", body: JSON.stringify({
            name: `Agent computer proxy: ${p.name.trim()}`, key: `AGENT_COMPUTER_PROXY_${p.id.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`,
            value: p.url.trim(), description: "Proxy URL for the Agent computer plugin; edit it from the plugin's settings." }) });
          rows[i] = { ...rows[i], secretId: made.id };
        }
        rows[i] = { ...rows[i], url: "" };
      }
      setProxies(rows);
      const usable = rows;
      const proxyCfg = { proxies: usable.map((p) => ({ id: p.id, name: p.name.trim(), url: { type: "secret_ref", version: "latest", secretId: p.secretId } })),
        defaultProxy, proxyFallback, agentProxies: Object.fromEntries(Object.entries(agentProxies).filter(([, v]) => v && v !== "default")) };
      const { sharedBrowsers: _old, ...rest } = config!;
      const next = { ...rest, computerUrl: String(config!.computerUrl).trim(), sites: list, sharedComputers, ...proxyCfg };
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
      <div style={{ ...s.help, marginBottom: 18, ...(setup.data?.connected ? s.ok : {}) }}>● {setup.data?.status ?? "Checking the computer…"}
        {setup.data?.versionNote ? <div style={{ color: "#c98a00", marginTop: 4 }}>Note: this plugin was {setup.data.versionNote}.</div> : null}</div>
      <Field label="Computer URL" help="Where Paperclip reaches the agent computer. On the same Docker network as Paperclip this is usually http://agent-computer:4100.">
        <input style={s.input} value={String(config.computerUrl ?? "")} onChange={(e) => set({ computerUrl: e.target.value })} placeholder="http://agent-computer:4100" />
      </Field>
      <Field label="Live screen address" help="Where people's browsers reach the live-screen gateway. Leave empty when your Paperclip address sends /_computer/ to the gateway (a path rule in your proxy or tunnel); otherwise the gateway's own address, e.g. https://computer.example.com.">
        <input style={s.input} value={String(config.screenUrl ?? "")} onChange={(e) => set({ screenUrl: e.target.value.trim() })} placeholder="Same as Paperclip (/_computer/)" />
      </Field>
      <Field label="Computer token" help="A Paperclip secret holding the computer's COMPUTER_TOKEN. Only this plugin uses it; agents and people never see it.">
        <select style={s.input} value={token?.secretId ?? ""} onChange={(e) => set({ computerToken: e.target.value ? { type: "secret_ref", version: "latest", secretId: e.target.value } : undefined })}>
          <option value="">Choose a secret…</option>
          {secrets.map((x) => <option key={x.id} value={x.id}>{x.name || x.key || x.id}</option>)}
        </select>
      </Field>
      <Field label="Proxies" help={<>Where the computers' web traffic goes out. With none, it goes out from wherever the computer runs, which for a server in a datacentre is a datacentre address that many sites block or challenge. Add a proxy (a residential one, for example): paste its URL, <code>http://user:password@host:port</code>, and test it; it is kept as a Paperclip secret. Proxies are checked every minute; choose below what happens when one stops working. Many residential providers rotate the address on every connection; choose a "sticky session" from them so a computer keeps one address and its logins.</>}>
        <div style={{ display: "grid", gap: 8 }}>
          {proxies.map((p, i) => (
            <div key={p.id} style={s.row}>
              <input style={{ ...s.input, flex: 1 }} value={p.name} placeholder="Name, e.g. US residential" onChange={(e) => { setNote(null); setProxies(proxies.map((x, j) => (j === i ? { ...x, name: e.target.value } : x))); }} />
              <input style={{ ...s.input, flex: 2 }} type="password" autoComplete="off" value={p.url}
                placeholder={p.secretId ? "Saved. Paste a new URL to change it" : "http://user:password@host:port"}
                onChange={(e) => { setNote(null); setProxies(proxies.map((x, j) => (j === i ? { ...x, url: e.target.value, check: null } : x))); }} />
              <button style={s.button} disabled={p.testing || (!p.url.trim() && !p.secretId)} onClick={async () => {
                setProxies((list) => list.map((x) => (x.id === p.id ? { ...x, testing: true } : x)));
                const check = (await testProxy(p.url.trim() ? { companyId, url: p.url } : { companyId, proxyId: p.id }).catch((e) => ({ ok: false, error: errText(e), ms: 0 }))) as ProxyResult;
                setProxies((list) => list.map((x) => (x.id === p.id ? { ...x, testing: false, check } : x)));
              }}>{p.testing ? "Testing…" : "Test"}</button>
              <button style={s.button} onClick={() => { setNote(null); setProxies(proxies.filter((_, j) => j !== i)); if (defaultProxy === p.id) setDefaultProxy("none"); }}>Remove</button>
            </div>
          )).flatMap((row, i) => {
            const p = proxies[i];
            const shown = p.check ?? (p.url.trim() ? null : setup.data?.proxies?.[p.id] ?? null);
            return [row, shown ? (
              <div key={`${p.id}-check`} style={{ fontSize: 12.5, marginTop: -2, ...(shown.ok ? s.ok : s.bad) }}>
                {shown.ok ? `✓ Working: sites see ${shown.ip} (${(shown.ms / 1000).toFixed(1)} s)` : `✗ ${shown.error}${p.check ? "" : proxyFallback === "stop" ? " Computers using it load no pages until it works again." : " Computers using it go out over their own connection until it works again."}`}
              </div>
            ) : null];
          })}
          <div style={s.row}>
            <button style={s.button} onClick={() => setProxies([...proxies, { id: `proxy-${Math.random().toString(36).slice(2, 10)}`, name: "", secretId: "", url: "" }])}>{proxies.length ? "Add another proxy" : "Add a proxy"}</button>
            {proxies.length ? <><span style={s.help}>Default for every computer:</span><ProxyPick value={defaultProxy} onChange={(v) => { setNote(null); setDefaultProxy(v); }} proxies={proxies} withDefault={false} /></> : null}
          </div>
          {proxies.length ? (
            <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>When a proxy stops working</div>
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
                <input type="radio" checked={proxyFallback === "direct"} onChange={() => { setNote(null); setProxyFallback("direct"); }} />
                <span><b>Keep working:</b> computers use their own connection until the proxy is back. Sites see the computer's real address meanwhile, and strict ones may challenge or log it out.</span>
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
                <input type="radio" checked={proxyFallback === "stop"} onChange={() => { setNote(null); setProxyFallback("stop"); }} />
                <span><b>Stop:</b> no pages load until the proxy works again, so sites never see the computer's real address. Agents say why and wait for it to be fixed.</span>
              </label>
            </div>
          ) : null}
        </div>
      </Field>
      <Field label="Agents' computers" help="Per agent: the sites it may reach (empty: any; or a list such as gohighlevel.com, *.msgsndr.com) and the proxy its traffic goes out through.">
        <div style={{ display: "grid", gap: 8 }}>
          {agents.map((a) => (
            <div key={a.id} style={{ display: "grid", gridTemplateColumns: proxies.length ? "minmax(0,180px) minmax(0,1fr) auto" : "minmax(0,180px) minmax(0,1fr)", gap: 10, alignItems: "center" }}>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
              <input style={s.input} value={sites[a.id] ?? ""} onChange={(e) => { setNote(null); setSites({ ...sites, [a.id]: e.target.value }); }} placeholder="Any site" />
              {proxies.length ? <ProxyPick value={agentProxies[a.id] ?? "default"} onChange={(v) => { setNote(null); setAgentProxies({ ...agentProxies, [a.id]: v }); }} proxies={proxies} /> : null}
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
                <div style={s.row}>
                  <input style={{ ...s.input, flex: 1 }} value={b.sites} onChange={(e) => edit({ sites: e.target.value })} placeholder="Allowed sites (empty: any)" />
                  {proxies.length ? <ProxyPick value={b.proxy ?? "default"} onChange={(v) => edit({ proxy: v })} proxies={proxies} /> : null}
                </div>
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
  const computers = usePluginAction("computers");
  const attention = usePluginAction("attention");
  const [needs, setNeeds] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!companyId) return;
    let live = true;
    const load = () => attention({ companyId, chat: "" }).then((r) => {
      if (live) setNeeds(new Map((r as Attention).pending.map((p) => [p.bot, p.kind === "password" ? p.reason : `Needs you: ${p.reason}`])));
    }).catch(() => undefined);
    void load();
    const timer = setInterval(load, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [companyId]);
  const [list, setList] = useState<{ agents: { id: string; name: string }[]; shared: { id: string; name: string; inUseBy: string | null }[] } | null>(null);
  const [agentId, setAgentId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("agent"));
  useEffect(() => {
    if (!companyId) return;
    let live = true;
    const load = () => computers({ companyId }).then((r) => {
      if (!live) return;
      const l = r as NonNullable<typeof list>;
      setList(l);
      setAgentId((cur) => {
        const id = cur ?? l.agents[0]?.id ?? null;
        // In the URL even when defaulted, so the corner card knows which computer is on screen.
        if (id && !cur) { const u = new URL(window.location.href); u.searchParams.set("agent", id); window.history.replaceState(null, "", u); }
        return id;
      });
    }).catch(() => undefined);
    void load();
    const timer = setInterval(load, 15_000); // who is using which shared computer
    return () => { live = false; clearInterval(timer); };
  }, [companyId]);
  // From Mattermost's Take over link: take the waiting request as soon as the computer is on screen, once.
  const [takeover] = useState(() => new URLSearchParams(window.location.search).get("takeover") === "1");
  const pick = (id: string) => {
    setAgentId(id);
    const u = new URL(window.location.href);
    u.searchParams.delete("takeover");
    u.searchParams.set("agent", id);
    window.history.replaceState(null, "", u);
  };
  if (!companyId) return null;
  const item = (id: string, label: string, sub?: string | null) => (
    <button key={id} onClick={() => pick(id)} title={needs.get(id) ?? undefined} style={{ ...s.button, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", display: "grid", ...(id === agentId ? { borderColor: "#2f6fed" } : needs.has(id) ? { borderColor: "rgba(242,169,0,.7)" } : { borderColor: "transparent" }) }}>
      <span style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
        {needs.has(id) ? <span style={{ flex: "none", fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 999, background: "rgba(242,169,0,.18)", color: "#f2a900" }}>Needs you</span> : null}
      </span>
      {sub ? <span style={{ ...s.help, fontSize: 11.5 }}>{sub}</span> : null}
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
        <LiveView key={agentId} companyId={companyId} agentId={agentId} autoTake={takeover && agentId === new URLSearchParams(window.location.search).get("agent")} />
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
function LiveView({ companyId, agentId, autoTake = false }: { companyId: string; agentId: string; autoTake?: boolean }) {
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

  const ticket = useCallback(async () => { const t = (await streamTicket({ companyId, agentId })) as { path: string; base: string | null }; return `${t.base ?? ""}${t.path}`; }, [companyId, agentId]);
  const autoTook = useRef(false);
  useEffect(() => {
    const c = view?.control;
    if (!autoTake || autoTook.current || !c) return;
    autoTook.current = true;
    const u = new URL(window.location.href);
    u.searchParams.delete("takeover");
    window.history.replaceState(null, "", u);
    if (c.holder !== "human" && c.requested && c.request) void run(() => control({ companyId, agentId, op: "take", requestId: c.request!.id }));
  }, [view, autoTake]);
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

type Attention = {
  pending: { bot: string; agentName: string; computer: string | null; kind: string; reason: string; at: number }[];
  active: { bot: string; agentName: string } | null;
};

/**
 * On every page, bottom right: a small live screen of a computer that needs a person (any page), or
 * of the agent being chatted with while it uses its computer. Click it to open it full size and take over.
 */
export function ComputerOverlay({ context }: PluginSidebarProps) {
  const companyId = context.companyId;
  const attention = usePluginAction("attention");
  const control = usePluginAction("control");
  const streamTicket = usePluginAction("stream-ticket");
  const [att, setAtt] = useState<Attention | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [chosen, setChosen] = useState<string | null>(null);
  /** Requests on screen when the card was minimized; a new one opens it again. */
  const [minimized, setMinimized] = useState<Set<string>>(new Set());
  /** The computer open full size. Held on its own: once taken over it is no longer "waiting", but stays open. */
  const [expanded, setExpanded] = useState<{ bot: string; agentName: string; computer: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) return;
    let live = true;
    const loop = async () => {
      while (live) {
        if (document.visibilityState === "visible") {
          const chat = /\/chats\/([^/?#]+)/.exec(window.location.pathname)?.[1] ?? "";
          try { const a = (await attention({ companyId, chat: decodeURIComponent(chat) })) as Attention; if (live) setAtt(a); } catch { /* next round */ }
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    };
    void loop();
    return () => { live = false; };
  }, [companyId]);

  // Not the computer already on screen in the Computers page, and not ones hidden with ×.
  // On the Computers page the list marks who needs you, so the card stays out of the way there.
  const onScreen = /\/computer$/.test(window.location.pathname) ? new URLSearchParams(window.location.search).get("agent") ?? "" : null;
  const keyOf = (p: { bot: string; at: number }) => `${p.bot}:${p.at}`;
  const waiting = (att?.pending ?? []).filter((p) => p.bot !== onScreen && !dismissed.has(keyOf(p)));
  const ask = waiting.find((p) => p.bot === chosen) ?? waiting[0] ?? null;
  const others = waiting.filter((p) => p !== ask);
  const active = att?.active && att.active.bot !== onScreen && !dismissed.has(`${att.active.bot}:active`) ? att.active : null;
  const target = ask ? { bot: ask.bot, agentName: ask.agentName } : active;
  const key = ask ? keyOf(ask) : target ? `${target.bot}:active` : null;
  const bot = target?.bot ?? "";
  const ticket = useCallback(async () => { const t = (await streamTicket({ companyId, agentId: bot })) as { path: string; base: string | null }; return `${t.base ?? ""}${t.path}`; }, [companyId, bot]);
  const onProblem = useCallback((p: string | null) => setProblem(p), []);
  if (!companyId) return null;
  if (expanded) {
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.55)", display: "grid", placeItems: "center", padding: 24 }} onClick={(e) => { if (e.target === e.currentTarget) setExpanded(null); }}>
        <div className="bg-background text-foreground" style={{ width: "min(1320px, 96vw)", maxHeight: "94vh", overflow: "auto", borderRadius: 14, padding: 16, boxShadow: "0 20px 60px rgba(0,0,0,.45)" }}>
          <div style={{ ...s.row, marginBottom: 10 }}>
            <span style={{ fontWeight: 600 }}>{`${expanded.agentName}${expanded.computer ? ` · shared ${expanded.computer} computer` : "'s computer"}`}</span>
            <span style={{ flex: 1 }} />
            <a href={`/${context.companyPrefix ?? ""}/computer?agent=${expanded.bot}`} style={{ ...s.help, color: "inherit" }}>Open in Computers</a>
            <button style={s.button} onClick={() => setExpanded(null)}>Minimize</button>
          </div>
          <LiveView key={expanded.bot} companyId={companyId} agentId={expanded.bot} />
        </div>
      </div>
    );
  }
  if (!target || onScreen !== null) return null;

  const takeOver = async () => {
    setBusy(true);
    try { await control({ companyId, agentId: bot, op: "take" }); setExpanded({ bot, agentName: target.agentName, computer: ask?.computer ?? null }); } catch (e) { setProblem(errText(e)); } finally { setBusy(false); }
  };
  const title = `${target.agentName}${ask?.computer ? ` · shared ${ask.computer} computer` : "'s computer"}`;
  const shownKeys = [...waiting.map(keyOf), ...(active && !ask ? [`${active.bot}:active`] : [])];
  if (shownKeys.length && shownKeys.every((k) => minimized.has(k))) {
    return (
      <button onClick={() => setMinimized(new Set())} title="Show"
        className="bg-background text-foreground"
        style={{ display: "flex", alignItems: "center", gap: 8, maxWidth: 300, padding: "8px 12px", borderRadius: 999, border: `1px solid ${ask ? "rgba(242,169,0,.7)" : "rgba(127,127,127,.35)"}`, boxShadow: "0 6px 20px rgba(0,0,0,.3)", font: "inherit", fontSize: 13, cursor: "pointer" }}>
        <span style={{ width: 8, height: 8, borderRadius: 8, flex: "none", background: ask ? "#f2a900" : "#2e9e6a" }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>{ask ? (waiting.length > 1 ? `${waiting.length} agents need you` : `${target.agentName} needs you`) : title}</span>
      </button>
    );
  }

  return (
    <div className="bg-background text-foreground" style={{ width: 360, borderRadius: 12, overflow: "hidden", border: `1px solid ${ask ? "rgba(242,169,0,.7)" : "rgba(127,127,127,.35)"}`, boxShadow: "0 10px 30px rgba(0,0,0,.35)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px" }}>
        <span style={{ width: 8, height: 8, borderRadius: 8, flex: "none", background: ask ? "#f2a900" : "#2e9e6a" }} />
        <span style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{title}</span>
        <button aria-label="Minimize" title="Minimize" style={{ ...s.button, padding: "2px 8px" }} onClick={() => setMinimized(new Set([...minimized, ...shownKeys]))}>–</button>
        <button aria-label="Open full size" title="Open full size" style={{ ...s.button, padding: "2px 8px" }} onClick={() => setExpanded({ bot, agentName: target.agentName, computer: ask?.computer ?? null })}>⤢</button>
        <button aria-label="Hide" title="Hide" style={{ ...s.button, padding: "2px 8px" }} onClick={() => { if (key) setDismissed(new Set([...dismissed, key])); setChosen(null); }}>×</button>
      </div>
      {ask ? <div style={{ padding: "0 10px 8px", fontSize: 12.5 }}>{ask.kind === "password" ? `Needs your ${ask.reason.replace(/^needs your /, "")}.` : `Needs you: ${ask.reason}`}</div> : null}
      <div style={{ cursor: "pointer", background: "rgba(127,127,127,.18)" }} onClick={() => setExpanded({ bot, agentName: target.agentName, computer: ask?.computer ?? null })} title="Open full size">
        <LiveScreen ticket={ticket} driving={false} onProblem={onProblem} />
      </div>
      {ask ? (
        <div style={{ display: "flex", gap: 8, padding: 10 }}>
          <button style={{ ...s.button, ...s.primary, flex: 1 }} disabled={busy} onClick={() => void (ask.kind === "password" ? Promise.resolve(setExpanded({ bot, agentName: target.agentName, computer: ask?.computer ?? null })) : takeOver())}>{ask.kind === "password" ? "Enter it" : "Take over"}</button>
        </div>
      ) : problem ? <div style={{ ...s.help, padding: "6px 10px" }}>{problem}</div> : null}
      {others.length ? (
        <div style={{ borderTop: "1px solid rgba(127,127,127,.3)" }}>
          <div style={{ ...s.help, padding: "6px 10px 2px" }}>{others.length === 1 ? "Also waiting for you:" : `${others.length} more waiting for you:`}</div>
          {others.map((p) => (
            <button key={keyOf(p)} onClick={() => setChosen(p.bot)} title="Show this one"
              style={{ display: "flex", gap: 8, alignItems: "center", width: "100%", padding: "6px 10px", border: "none", background: "transparent", color: "inherit", font: "inherit", fontSize: 12.5, textAlign: "left", cursor: "pointer" }}>
              <span style={{ width: 7, height: 7, borderRadius: 7, flex: "none", background: "#f2a900" }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><b>{p.agentName}</b>{p.computer ? ` (shared ${p.computer})` : ""}: {p.kind === "password" ? p.reason : p.reason}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
