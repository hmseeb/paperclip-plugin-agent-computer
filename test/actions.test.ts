import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/actions.ts";
import { Computer, egressFor } from "../src/computer.ts";

/** A computer that records calls and answers from a script. */
function fake(answer: (path: string, body: unknown) => [number, unknown] = () => [200, {}]) {
  const calls: { bot: string; method: string; path: string; body: unknown; auth: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const h = init.headers as Record<string, string>;
    calls.push({ bot: h["x-openbot-bot-id"], method: String(init.method), path, body, auth: h.authorization });
    const [status, json] = answer(path, body);
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
  return { calls, computer: new Computer("http://computer:4100/", "tok", f) };
}

const deps = (computer: Computer, sites: Record<string, string[]> = {}, asked: unknown[] = []) => ({
  computer, sites: (id: string) => sites[id] ?? [], needsPerson: async (...a: unknown[]) => { asked.push(a); },
});

test("each agent drives its own browser; open sets which sites it may reach first", async () => {
  const f = fake((p) => [200, p === "/navigate" ? { title: "Example" } : {}]);
  const r = await handle(deps(f.computer, { "a-reply": ["gohighlevel.com"] }), "a-reply", "open", { url: "https://app.gohighlevel.com" });
  assert.equal(r.status, 200);
  assert.deepEqual(f.calls.map((c) => [c.bot, c.method, c.path]), [["a-reply", "PUT", "/egress-policy"], ["a-reply", "POST", "/navigate"]]);
  assert.deepEqual(f.calls[0].body, { policy: { mode: "allowlist_only", rules: [{ type: "domain", value: "gohighlevel.com" }] } });
  assert.equal(f.calls[0].auth, "Bearer tok");
  await handle(deps(f.computer), "a-cto", "open", { url: "https://example.com" });
  assert.deepEqual(f.calls[2].body, { policy: { mode: "allow_all", rules: [] } });
});

test("sites from settings are cleaned up", () => {
  assert.deepEqual(egressFor([" https://GoHighLevel.com/login ", "*.msgsndr.com", ""]).rules.map((r) => r.value), ["gohighlevel.com", "*.msgsndr.com"]);
  assert.equal(egressFor([]).mode, "allow_all");
});

test("click and type pass the ref and snapshot; a stale ref says to look again", async () => {
  const f = fake((p) => (p === "/click" ? [409, { error: "That ref is from an old snapshot.", stale: true }] : [200, { typed: true }]));
  const r = await handle(deps(f.computer), "a", "click", { ref: "e12", snapshotId: "3" });
  assert.equal(r.status, 409);
  assert.match((r.body as { error: string }).error, /fresh look/);
  assert.deepEqual(f.calls[0].body, { ref: "e12", snapshotId: 3 });
  await handle(deps(f.computer), "a", "type", { ref: "e4", snapshotId: 3, text: "hello", submit: true });
  assert.deepEqual(f.calls[1].body, { ref: "e4", snapshotId: 3, text: "hello", submit: true });
});

test("while a person has the browser the agent is told to wait", async () => {
  const f = fake(() => [409, { error: "A person has control.", humanHasControl: true }]);
  const r = await handle(deps(f.computer), "a", "scroll", {});
  assert.equal(r.status, 409);
  assert.match((r.body as { error: string }).error, /wait, then check \/pc\/status/);
});

test("asking for help or a password tells people, with the page it is on", async () => {
  const asked: unknown[][] = [];
  const f = fake((p) => [200, p === "/read" ? { url: "https://app.gohighlevel.com/login" } : { holder: "bot", requested: true }]);
  const d = deps(f.computer, {}, asked);
  assert.equal((await handle(d, "a", "ask-for-help", {})).status, 400, "a reason is required");
  assert.equal((await handle(d, "a", "ask-for-help", { reason: "2FA prompt" })).status, 200);
  await handle(d, "a", "ask-for-password", { ref: "e7", snapshotId: 2, label: "GoHighLevel password" });
  assert.deepEqual(asked, [["a", "help", "2FA prompt", "https://app.gohighlevel.com/login"], ["a", "password", "needs your GoHighLevel password", "https://app.gohighlevel.com/login"]]);
  assert.deepEqual(f.calls.find((c) => c.path === "/control/secret")?.body, { ref: "e7", snapshotId: 2, label: "GoHighLevel password" });
});

test("an unreachable computer is reported, an unknown call is a 404", async () => {
  const down = new Computer("http://computer:4100", "tok", (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch);
  assert.equal((await handle(deps(down), "a", "read", {})).status, 502);
  assert.equal((await handle(deps(fake().computer), "a", "exec", {})).status, 404, "the shell is not exposed");
});
