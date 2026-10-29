import { test } from "node:test";
import assert from "node:assert/strict";
import { Leases, sharedBrowsers, summarize, type Step } from "../src/learning.ts";

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
    "1. Opened https://app.gohighlevel.com/",
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
  assert.deepEqual(sharedBrowsers({ sharedBrowsers: [{ id: "shared-ghl", name: "GoHighLevel", agents: ["a"] }, { id: "../etc", name: "x" }] }),
    [{ id: "shared-ghl", name: "GoHighLevel", allAgents: true, agents: ["a"], sites: [] }]);
});

test("a shared browser is for every agent unless the board picks some", async () => {
  const { mayUse } = await import("../src/learning.ts");
  const [all, picked] = sharedBrowsers({ sharedBrowsers: [{ id: "shared-a", name: "A" }, { id: "shared-b", name: "B", allAgents: false, agents: ["cto"] }] });
  assert.equal(mayUse(all, "anyone"), true, "all agents by default, new ones included");
  assert.equal(mayUse(picked, "cto"), true);
  assert.equal(mayUse(picked, "ceo"), false);
});
