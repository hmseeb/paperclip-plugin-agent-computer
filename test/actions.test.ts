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
  computer,
  pick: async (id: string, name: string) => (name ? { status: 403, error: "not assigned" } : { bot: id, label: "your browser", sites: sites[id] ?? [], shared: false }),
  computers: async () => [],
  release: async () => false,
  needsPerson: async (id: string, b: { bot: string }, kind: string, reason: string, url: string | null) => { asked.push([id, kind, reason, url]); },
  takeDemonstration: async () => null,
  howtos: { list: async () => [], save: async () => {}, forget: async () => false, teach: async () => null },
  sleep: async () => {},
});

test("each agent drives its own browser; open sets which sites it may reach first", async () => {
  const f = fake((p) => [200, p === "/navigate" ? { title: "Example" } : {}]);
  const r = await handle(deps(f.computer, { "a-reply": ["gohighlevel.com"] }), "a-reply", "open", { url: "https://app.gohighlevel.com" });
  assert.equal(r.status, 200);
  assert.deepEqual(f.calls.map((c) => [c.bot, c.method, c.path]), [["a-reply", "PUT", "/egress-policy"], ["a-reply", "POST", "/navigate"]]);
  assert.deepEqual(f.calls[0].body, { policy: { mode: "allowlist_only", rules: [{ type: "domain", value: "gohighlevel.com" }] }, upstream: null });
  assert.equal(f.calls[0].auth, "Bearer tok");
  await handle(deps(f.computer), "a-cto", "open", { url: "https://example.com" });
  assert.deepEqual(f.calls[2].body, { policy: { mode: "allow_all", rules: [] }, upstream: null });
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
  assert.match((r.body as { error: string }).error, /call \/pc\/wait/);
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

test("the address bar opens addresses and searches everything else", async () => {
  const { addressFor } = await import("../src/computer.ts");
  assert.equal(addressFor("Highlevel"), "https://www.google.com/search?q=Highlevel");
  assert.equal(addressFor("gohighlevel login"), "https://www.google.com/search?q=gohighlevel%20login");
  assert.equal(addressFor("gohighlevel.com"), "https://gohighlevel.com");
  assert.equal(addressFor("app.gohighlevel.com/v2/location"), "https://app.gohighlevel.com/v2/location");
  assert.equal(addressFor("http://example.com"), "http://example.com");
  assert.equal(addressFor("localhost:3000"), "https://localhost:3000");
});

test("wait returns when the person hands back, with what they did, shown once", async () => {
  let holder = "human";
  const f = fake((p) => [200, p === "/control" ? { holder, requested: holder === "human" } : {}]);
  let demo: unknown = { from: 1, to: 2, reason: "2FA", steps: ['1. Clicked button "Verify"'] };
  const d = { ...deps(f.computer), takeDemonstration: async () => { const x = demo; demo = null; return x as never; } };
  const still = await handle(d, "a", "wait", {});
  assert.equal((still.body as { done: boolean }).done, false);
  assert.equal((still.body as { personDid?: unknown }).personDid, undefined, "not while they still have it");
  holder = "bot";
  const done = (await handle(d, "a", "wait", {})).body as { done: boolean; personDid?: { steps: string[] } };
  assert.equal(done.done, true);
  assert.deepEqual(done.personDid?.steps, ['1. Clicked button "Verify"']);
  const again = (await handle(d, "a", "status", {})).body as { personDid?: unknown };
  assert.equal(again.personDid, undefined, "shown once");
});

test("a shared browser the agent is not assigned is refused before the computer is touched", async () => {
  const f = fake();
  const r = await handle(deps(f.computer), "a", "open", { url: "https://x.com", computer: "GoHighLevel" });
  assert.equal(r.status, 403);
  assert.equal(f.calls.length, 0);
});

test("how-tos are saved, listed, taught and forgotten through the agent's routes", async () => {
  const saved: Record<string, { name: string; steps: string }[]> = {};
  const d = { ...deps(fake().computer), howtos: {
    list: async (id: string) => saved[id] ?? [],
    save: async (id: string, h: { name: string; steps: string }) => { saved[id] = [...(saved[id] ?? []).filter((x) => x.name !== h.name), h]; },
    forget: async (id: string, n: string) => { const b = (saved[id] ?? []).length; saved[id] = (saved[id] ?? []).filter((x) => x.name !== n); return saved[id].length < b; },
    teach: async (id: string, n: string, to: string) => { const h = (saved[id] ?? []).find((x) => x.name === n); if (!h) return null; saved[to] = [h]; return to; },
  } };
  assert.equal((await handle(d, "a", "save-howto", { name: "Export contacts" })).status, 400, "steps required");
  assert.equal((await handle(d, "a", "save-howto", { name: "Export contacts", steps: "1. Open contacts" })).status, 200);
  assert.equal((await handle(d, "a", "teach", { name: "Export contacts", agent: "b" })).status, 200);
  assert.deepEqual(((await handle(d, "b", "howtos", {})).body as { howtos: { name: string }[] }).howtos.map((h) => h.name), ["Export contacts"]);
  assert.equal((await handle(d, "a", "forget-howto", { name: "Export contacts" })).status, 200);
  assert.equal((await handle(d, "a", "teach", { name: "Export contacts", agent: "b" })).status, 404);
});

test("after a hand-back, opening a page takes the fresh look itself", async () => {
  let looked = false;
  const f = fake((p) => (p === "/snapshot" ? (looked = true, [200, {}]) : p === "/navigate" && !looked ? [409, { error: "Take a fresh browser snapshot after handback before acting.", snapshotRequired: true }] : [200, { title: "Example" }]));
  const r = await handle(deps(f.computer), "a", "open", { url: "https://example.com" });
  assert.equal(r.status, 200);
  assert.deepEqual(f.calls.map((c) => c.path), ["/egress-policy", "/navigate", "/snapshot", "/navigate"]);
});
