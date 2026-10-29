// What an agent does with its computer, as plugin API routes only agents can call. Paperclip
// checks which agent is calling, and the agent's id is the browser it gets, so an agent only
// ever drives its own browser. Browser only: the computer's shell and files are not exposed.
import { ComputerError, egressFor, type Computer } from "./computer.ts";

export interface ActionDeps {
  computer: Computer;
  /** Sites this agent may reach (settings); empty: any. */
  sites(agentId: string): string[];
  /** Tells people the agent needs them (the Mattermost plugin posts a Take over button). */
  needsPerson(agentId: string, kind: "help" | "password", reason: string, url: string | null): Promise<void>;
}

type Result = { status: number; body: unknown };
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : undefined);

export async function handle(d: ActionDeps, agentId: string, routeKey: string, input: Record<string, unknown>): Promise<Result> {
  const c = d.computer;
  const act = (path: string, body: Record<string, unknown>) => c.call(agentId, "POST", path, body);
  try {
    switch (routeKey) {
      case "open": {
        const url = str(input.url);
        if (!url) return { status: 400, body: { error: "url is required" } };
        await c.egress(agentId, egressFor(d.sites(agentId))); // pushed each time: the computer forgets it on restart
        return ok(await act("/navigate", { url }));
      }
      case "read": return ok(await c.call(agentId, "GET", "/read"));
      case "look": return ok(await act("/snapshot", {}));
      case "click": return ok(await act("/click", { ref: str(input.ref), snapshotId: num(input.snapshotId) }));
      case "type": return ok(await act("/type", { ref: str(input.ref), snapshotId: num(input.snapshotId), text: typeof input.text === "string" ? input.text : "", submit: input.submit === true || input.submit === "true" }));
      case "key": return ok(await act("/key", { key: str(input.key), ...(str(input.ref) ? { ref: str(input.ref), snapshotId: num(input.snapshotId) } : {}) }));
      case "scroll": return ok(await act("/scroll", { deltaY: num(input.deltaY) ?? 600 }));
      case "screenshot": return ok(await c.call(agentId, "GET", "/screenshot"));
      case "status": return ok(await c.call(agentId, "GET", "/control"));
      case "ask-for-help": {
        const reason = str(input.reason);
        if (!reason) return { status: 400, body: { error: "say what you need a person to do (reason)" } };
        const state = await act("/control/request", { reason });
        const page = await c.call<{ url?: string }>(agentId, "GET", "/read").catch(() => ({ url: undefined }));
        await d.needsPerson(agentId, "help", reason, page.url ?? null);
        return ok({ ...state, note: "A person has been asked to take over. Check /pc/status; when you have control back, take a fresh look before acting." });
      }
      case "ask-for-password": {
        const label = str(input.label) || "password";
        const state = await act("/control/secret", { ref: str(input.ref), snapshotId: num(input.snapshotId), label });
        const page = await c.call<{ url?: string }>(agentId, "GET", "/read").catch(() => ({ url: undefined }));
        await d.needsPerson(agentId, "password", `needs your ${label}`, page.url ?? null);
        return ok({ ...state, note: "A person has been asked to type it into the field. You never see it. Check /pc/status until secretWanted is gone." });
      }
      default: return { status: 404, body: { error: `unknown action ${routeKey}` } };
    }
  } catch (err) {
    if (err instanceof ComputerError) {
      const hint = err.body.humanHasControl ? " A person has the browser right now; wait, then check /pc/status."
        : err.body.stale || err.body.snapshotRequired ? " Take a fresh look (/pc/look) and use the new refs." : "";
      return { status: err.status === 499 ? 409 : err.status, body: { ...err.body, error: `${err.message}${hint}` } };
    }
    return { status: 502, body: { error: `The computer is unreachable: ${String((err as Error)?.message ?? err).slice(0, 200)}` } };
  }
}

const ok = (body: unknown): Result => ({ status: 200, body });
