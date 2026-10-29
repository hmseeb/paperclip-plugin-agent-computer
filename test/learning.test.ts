import { test } from "node:test";
import assert from "node:assert/strict";
import { Leases, sharedComputers, summarize, type Step } from "../src/learning.ts";

test("a person's steps read as a how-to, without anything they typed", () => {
  const u = "https://app.gohighlevel.com/contacts";
  const steps: Step[] = [
    { at: 1, kind: "open", url: "https://app.gohighlevel.com/" },
    { at: 2, kind: "click", url: u, target: { role: "button", name: "Export" } },
    { at: 3, kind: "type", url: u, target: { role: "textbox", name: "Search" } },
    { at: 4, kind: "type", url: u, target: { role: "textbox", name: "Search" } },
    { at: 5, kind: "key", key: "Enter", url: u },
    { at: 6, kind: "scroll", deltaY: 300, url: u },
    { at: 7, kind: "scroll", deltaY: 300, url: u },
    { at: 8, kind: "type", url: u, target: { role: "textbox", name: "[sensitive field]", sensitive: true } },
  ];
  assert.deepEqual(summarize(steps), [
    "1. Opened https://app.gohighlevel.com",
    "On app.gohighlevel.com/contacts:",
    '2. Clicked button "Export"',
    '3. Typed into textbox "Search"',
    "4. Pressed Enter",
    "5. Scrolled down",
    "6. Typed a password or code (a person's secret: ask for it with ask-for-password)",
  ]);
});

test("a shared browser is leased to one agent at a time, renewed by use, freed by release or time", () => {
  let now = 0;
  const l = new Leases(1000, () => now);
  assert.deepEqual(l.take("shared-ghl", "a"), { ok: true });
  assert.deepEqual(l.take("shared-ghl", "b"), { ok: false, holder: "a" });
  now = 900; l.take("shared-ghl", "a"); now = 1500;
  assert.equal(l.take("shared-ghl", "b").ok, false, "renewed by a's use");
  now = 3000;
  assert.equal(l.take("shared-ghl", "b").ok, true, "expired");
  assert.equal(l.release("shared-ghl", "a"), false, "only the holder releases");
  assert.equal(l.release("shared-ghl", "b"), true);
  assert.equal(l.holder("shared-ghl"), null);
});

test("shared browsers from settings: only well-formed ids", () => {
  assert.deepEqual(sharedComputers({ sharedComputers: [{ id: "shared-ghl", name: "GoHighLevel", agents: ["a"] }, { id: "../etc", name: "x" }] }),
    [{ id: "shared-ghl", bot: "shared-ghl", name: "GoHighLevel", allAgents: true, agents: ["a"], sites: [] }]);
});

test("a shared browser is for every agent unless the board picks some", async () => {
  const { mayUse } = await import("../src/learning.ts");
  const [all, picked] = sharedComputers({ sharedComputers: [{ id: "shared-a", name: "A" }, { id: "shared-b", name: "B", allAgents: false, agents: ["cto"] }] });
  assert.equal(mayUse(all, "anyone"), true, "all agents by default, new ones included");
  assert.equal(mayUse(picked, "cto"), true);
  assert.equal(mayUse(picked, "ceo"), false);
});

test("a computer's proxy: its own choice, else the default; none means the host's own connection", async () => {
  const { proxyChoice } = await import("../src/learning.ts");
  assert.equal(proxyChoice(undefined, "res"), "res");
  assert.equal(proxyChoice("default", "res"), "res");
  assert.equal(proxyChoice("other", "res"), "other");
  assert.equal(proxyChoice("none", "res"), null);
  assert.equal(proxyChoice(undefined, undefined), null);
  assert.equal(proxyChoice(undefined, "none"), null);
});

test("each computer's proxy goes to the computer with its network policy", async () => {
  const { Computer } = await import("../src/computer.ts");
  const bodies: unknown[] = [];
  const c = new Computer("http://c:4100", "tok", (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response("{}"); }) as typeof fetch,
    (bot) => (bot === "a" ? "http://u:p@res:7000" : null));
  await c.egress("a", { mode: "allow_all", rules: [] });
  await c.egress("b", { mode: "allow_all", rules: [] });
  assert.deepEqual(bodies.map((b) => (b as { upstream: unknown }).upstream), ["http://u:p@res:7000", null]);
});

test("a computer a person walked away from goes back to its agent; one being watched never does", async () => {
  const { abandoned } = await import("../src/learning.ts");
  const min = 60_000, now = 100 * min;
  assert.equal(abandoned({ heldFor: 60 * min, viewers: 1, lastWatched: now, gatewayUp: 60 * min, now }), false, "someone has it open");
  assert.equal(abandoned({ heldFor: 60 * min, viewers: 0, lastWatched: now - 2 * min, gatewayUp: 60 * min, now }), false, "closed it a moment ago (a reload)");
  assert.equal(abandoned({ heldFor: 60 * min, viewers: 0, lastWatched: now - 6 * min, gatewayUp: 60 * min, now }), true, "page closed 6 minutes ago");
  assert.equal(abandoned({ heldFor: 3 * min, viewers: 0, lastWatched: now - 6 * min, gatewayUp: 60 * min, now }), false, "just taken (from Mattermost, page still loading)");
  assert.equal(abandoned({ heldFor: 35 * min, viewers: 0, lastWatched: null, gatewayUp: 60 * min, now }), true, "no record of anyone watching, held 35 minutes");
  assert.equal(abandoned({ heldFor: 35 * min, viewers: 0, lastWatched: null, gatewayUp: 2 * min, now }), false, "gateway just restarted: give people time to reconnect");
});

test("steps keep no secrets from addresses: no query, no long or secret-looking parts, searches without words", async () => {
  const { safeUrl, summarize } = await import("../src/learning.ts");
  assert.equal(safeUrl("https://app.example.com/reset/abc?token=123#x"), "https://app.example.com/[redacted]/abc");
  assert.equal(safeUrl("https://site.com/a/" + "x".repeat(50)), "https://site.com/a/[redacted]");
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.deepEqual(summarize([{ at: 1, kind: "search" }, { at: 2, kind: "open", url: "https://login.example.com/cb?code=SECRET" }]),
    ["1. Searched Google", "2. Opened https://login.example.com/cb"]);
});

test("shared computers are tied to their company, and a lease ends after an hour however busy", async () => {
  const { sharedComputers, Leases } = await import("../src/learning.ts");
  const [a] = sharedComputers({ sharedComputers: [{ id: "shared-ghl", name: "GHL" }] }, "25ad68f4-ac50");
  const [b] = sharedComputers({ sharedComputers: [{ id: "shared-ghl", name: "GHL" }] }, "3ed8cd7c-f0c5");
  assert.notEqual(a.bot, b.bot);
  let now = 0;
  const l = new Leases(10 * 60_000, () => now);
  l.take("s", "greedy");
  for (now = 0; now <= 55 * 60_000; now += 5 * 60_000) l.take("s", "greedy"); // keeps renewing
  now = 58 * 60_000;
  assert.equal(l.take("s", "other").ok, false);
  now = 61 * 60_000;
  assert.deepEqual(l.take("s", "greedy"), { ok: false, holder: "greedy", cooldown: true }, "its hour is up: not straight back");
  assert.equal(l.take("s", "other").ok, true, "an hour is the most one agent holds it");
  l.free("s");
  assert.equal(l.holder("s"), null);
});
