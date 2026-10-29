// What an agent does with its computer, as plugin API routes only agents can call. Paperclip
// checks which agent is calling. A call drives the agent's own browser, or a shared one the board
// assigned to it (`computer`), leased to one agent at a time. The web only: the computer's shell and
// files are not exposed.
import { ComputerError, egressFor, type Computer } from "./computer.ts";
import type { Demonstration } from "./learning.ts";

/** A browser a call runs in: `bot` is the computer's id for it. */
export interface Target { bot: string; label: string; sites: string[]; shared: boolean }
export interface HowTo { name: string; site?: string; steps: string; notes?: string; updatedAt: string; learnedFrom?: string }

export interface ActionDeps {
  computer: Computer;
  /** The browser for this call, or the reason it is refused (not assigned, in use by another agent). */
  pick(agentId: string, name: string): Promise<Target | { status: number; error: string }>;
  computers(agentId: string): Promise<{ name: string; shared: boolean; inUseBy: string | null }[]>;
  release(agentId: string, name: string): Promise<boolean>;
  /** Tells people the agent needs them (the Mattermost plugin posts a Take over link). */
  needsPerson(agentId: string, b: Target, kind: "help" | "password", reason: string, url: string | null): Promise<void>;
  /** The latest demonstration in this browser the agent has not been shown yet; marks it shown. */
  takeDemonstration(bot: string, agentId: string): Promise<Demonstration | null>;
  howtos: {
    list(agentId: string): Promise<HowTo[]>;
    save(agentId: string, h: HowTo): Promise<void>;
    forget(agentId: string, name: string): Promise<boolean>;
    /** Copies one to another agent of the company; returns its name, or null when there is no such agent. */
    teach(agentId: string, name: string, to: string): Promise<string | null>;
  };
  sleep?: (ms: number) => Promise<void>;
  /**
   * A page failed on a computer with a proxy: true when the proxy is down and calls now go direct (retry);
   * `{ stopped }` when it is down and the settings say not to go out without it.
   */
  proxyFailed?(bot: string): Promise<boolean | { stopped: string }>;
}

type Result = { status: number; body: unknown };
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : undefined);
/** Which shared computer a call names (`computer`; `browser` from before the rename still works). */
const which = (input: Record<string, unknown>) => str(input.computer) || str(input.browser);
const ok = (body: unknown): Result => ({ status: 200, body });
const bad = (status: number, error: string): Result => ({ status, body: { error } });
const WAIT_MS = 20_000; // under the host's 30 s limit for one call

type Control = { holder?: string; requested?: boolean; secretWanted?: string };
const settled = (c: Control) => c.holder === "bot" && !c.requested && !c.secretWanted;

export async function handle(d: ActionDeps, agentId: string, routeKey: string, input: Record<string, unknown>): Promise<Result> {
  // Calls that are not about a browser.
  switch (routeKey) {
    case "computers": return ok({ computers: await d.computers(agentId) });
    case "howtos": return ok({ howtos: await d.howtos.list(agentId) });
    case "save-howto": {
      const name = str(input.name).slice(0, 80), steps = str(input.steps);
      if (!name || !steps) return bad(400, "name and steps are required");
      if (steps.length > 8000) return bad(400, "steps are too long (8000 characters at most)");
      await d.howtos.save(agentId, { name, steps, site: str(input.site) || undefined, notes: str(input.notes).slice(0, 2000) || undefined, updatedAt: new Date().toISOString() });
      return ok({ saved: name });
    }
    case "forget-howto": return (await d.howtos.forget(agentId, str(input.name))) ? ok({ forgotten: str(input.name) }) : bad(404, "no how-to by that name");
    case "teach": {
      const name = str(input.name), to = str(input.agent);
      if (!name || !to) return bad(400, "name (the how-to) and agent (who to teach) are required");
      const taught = await d.howtos.teach(agentId, name, to);
      return taught ? ok({ taught: name, to: taught }) : bad(404, `no how-to "${name}", or no agent "${to}" in your company`);
    }
    case "release": {
      return (await d.release(agentId, which(input))) ? ok({ released: which(input) }) : bad(409, "you are not using that shared computer");
    }
  }

  const b = await d.pick(agentId, which(input));
  if ("error" in b) return bad(b.status, b.error);
  const c = d.computer;
  const act = (path: string, body: Record<string, unknown>) => c.call(b.bot, "POST", path, body);
  // After a hand-back the computer wants a fresh look before any action. Opening a page, a key or a
  // scroll names no element, so take that look for the agent rather than failing.
  const freshly = async (path: string, body: Record<string, unknown>) => {
    try { return await act(path, body); } catch (err) {
      if (!(err instanceof ComputerError && err.body.snapshotRequired)) throw err;
      await act("/snapshot", {});
      return act(path, body);
    }
  };
  const pageUrl = () => c.call<{ url?: string }>(b.bot, "GET", "/read").then((r) => r.url ?? null).catch(() => null);
  try {
    let res: Result;
    switch (routeKey) {
      case "open": {
        const url = str(input.url);
        if (!url) return bad(400, "url is required");
        await c.egress(b.bot, egressFor(b.sites)); // pushed each time: the computer forgets it on restart
        try {
          res = ok(await freshly("/navigate", { url }));
        } catch (err) {
          // A dead proxy: switch this computer to its own connection and try once more.
          // Chrome words a dead proxy several ways, so any failed load is a reason to check it (cheap, and only with a proxy).
          const down = err instanceof ComputerError && err.status === 502 ? await d.proxyFailed?.(b.bot) : false;
          if (down && typeof down === "object") return bad(503, `Your proxy "${down.stopped}" is not working, and the plugin settings say not to go out without it, so no page will load until it is fixed. Tell the person you are working with; do not look for a way round it.`);
          if (!down) throw err;
          await c.egress(b.bot, egressFor(b.sites));
          // Chrome takes a moment to drop the dead route, so twice, a little apart.
          const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
          let page: Record<string, unknown> | undefined;
          for (let attempt = 0; !page; attempt++) {
            await sleep(1500);
            try { page = await freshly("/navigate", { url }); } catch (again) { if (attempt >= 1) throw again; }
          }
          res = ok({ ...page, note: "Your proxy is not working, so this page was opened over the computer's own connection. People see this in the plugin settings." });
        }
        break;
      }
      case "read": res = ok(await c.call(b.bot, "GET", "/read")); break;
      case "look": res = ok(await act("/snapshot", {})); break;
      case "click": res = ok(await act("/click", { ref: str(input.ref), snapshotId: num(input.snapshotId) })); break;
      case "type": res = ok(await act("/type", { ref: str(input.ref), snapshotId: num(input.snapshotId), text: typeof input.text === "string" ? input.text : "", submit: input.submit === true || input.submit === "true" })); break;
      case "key": res = ok(await (str(input.ref) ? act : freshly)("/key", { key: str(input.key), ...(str(input.ref) ? { ref: str(input.ref), snapshotId: num(input.snapshotId) } : {}) })); break;
      case "scroll": res = ok(await freshly("/scroll", { deltaY: num(input.deltaY) ?? 600 })); break;
      case "screenshot": res = ok(await c.call(b.bot, "GET", "/screenshot")); break;
      case "status": res = ok(await c.call(b.bot, "GET", "/control")); break;
      case "ask-for-help": {
        const reason = str(input.reason);
        if (!reason) return bad(400, "say what you need a person to do (reason)");
        const state = await act("/control/request", { reason });
        await d.needsPerson(agentId, b, "help", reason, await pageUrl());
        return ok({ ...state, next: "A person has been asked. Now call /pc/wait (again until done is true): it returns when they hand the computer back, with the steps they took." });
      }
      case "ask-for-password": {
        const label = str(input.label) || "password";
        const state = await act("/control/secret", { ref: str(input.ref), snapshotId: num(input.snapshotId), label });
        await d.needsPerson(agentId, b, "password", `needs your ${label}`, await pageUrl());
        return ok({ ...state, next: "A person has been asked to type it into the field; you never see it. Now call /pc/wait until done is true." });
      }
      // Returns when the person is done (handed back, password entered) or after 20 s; call again until done.
      case "wait": {
        const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
        const end = Date.now() + WAIT_MS;
        let state = await c.call<Control>(b.bot, "GET", "/control");
        while (!settled(state) && Date.now() < end) {
          await sleep(1000);
          state = await c.call<Control>(b.bot, "GET", "/control");
        }
        if (!settled(state)) return ok({ done: false, holder: state.holder, next: "Still with a person. Call /pc/wait again." });
        res = ok({ done: true, next: "The person is done. Take a fresh look (/pc/look) and carry on with the task; do not ask them to confirm." });
        break;
      }
      default: return bad(404, `unknown action ${routeKey}`);
    }
    // Whatever a person did in this browser since the agent last heard, so it can learn it.
    const demo = await d.takeDemonstration(b.bot, agentId);
    if (demo && res.body && typeof res.body === "object") {
      res.body = { ...(res.body as object), personDid: { ...demo, next: "A person used this computer. If these steps do something you will need again, save them as a how-to (/pc/howtos), or update the one they correct." } };
    }
    return res;
  } catch (err) {
    if (err instanceof ComputerError) {
      const hint = err.body.humanHasControl ? " A person has the computer right now; call /pc/wait."
        : err.body.stale || err.body.snapshotRequired ? " Take a fresh look (/pc/look) and use the new refs." : "";
      return { status: err.status === 499 ? 409 : err.status, body: { ...err.body, error: `${err.message}${hint}` } };
    }
    return bad(502, `The computer is unreachable: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }
}
