import { test } from "node:test";
import assert from "node:assert/strict";
import { newShareId, openable, readReplayToken, readShareToken, replayToken, shareKey, shareToken, validPattern } from "../gateway/share-core.ts";
import { describe, MAX_HOURS, newShare, parseShareInput, replayLink, shareLink } from "../src/shares.ts";

const key = shareKey("tok");
const bytes = new Uint8Array(Array.from({ length: 12 }, (_, i) => i * 37));

test("share links: signed, reusable until they expire, and not good as replays (or vice versa)", () => {
  const id = newShareId(bytes);
  assert.match(id, /^[a-z2-7]{12}$/);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const t = shareToken(key, id, exp);
  assert.deepEqual(readShareToken(key, t), { id, exp });
  assert.deepEqual(readShareToken(key, t), { id, exp }, "reusable");
  assert.equal(readShareToken(shareKey("other"), t), null, "another computer's key");
  assert.equal(readShareToken(key, t.replace(/.$/, (c) => (c === "a" ? "b" : "a"))), null, "tampered");
  assert.equal(readShareToken(key, shareToken(key, id, exp - 7200)), null, "expired");
  assert.equal(readReplayToken(key, t), null, "a share link is not a replay link");
  assert.equal(readShareToken(key, replayToken(key, id, exp)), null);
  assert.equal(readShareToken(key, "../../etc.1.2"), null);
});

test("addresses people may give", () => {
  for (const ok of ["dcc.godaddy.com/control/*/dns", "*.vercel.com", "https://sso.godaddy.com", "ap.www.namecheap.com/domains/list"]) assert.ok(validPattern(ok), ok);
  for (const bad of ["", "godaddy", "javascript:alert(1)", "a b.com", "x.com/ a"]) assert.ok(!validPattern(bad), bad);
  assert.equal(openable("dcc.godaddy.com/control/x/dns"), "https://dcc.godaddy.com/control/x/dns");
  assert.equal(openable("*.vercel.com"), null);
});

test("asking for a share: defaults, start page, limits", () => {
  const r = parseShareInput({ allow: "dcc.godaddy.com/control/*\nsso.godaddy.com", title: "Connect badaaas.com to Vercel" });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.value.allow, ["dcc.godaddy.com/control/*", "sso.godaddy.com"]);
  assert.equal(r.value.start, "https://sso.godaddy.com", "the first address without a wildcard");
  assert.equal(r.value.mode, "login");
  assert.equal(r.value.hours, 48);
  assert.equal((parseShareInput({ allow: ["x.com"], hours: 1000 }) as { value: { hours: number } }).value.hours, MAX_HOURS);
  assert.match((parseShareInput({ allow: [] }) as { error: string }).error, /allow is required/);
  assert.match((parseShareInput({ allow: ["*.x.com"] }) as { error: string }).error, /start is required/);
  assert.match((parseShareInput({ allow: ["x.com"], mode: "lend" }) as { error: string }).error, /lend is required/);
  assert.match((parseShareInput({ allow: ["bad host"] }) as { error: string }).error, /not an address/);
  const lend = parseShareInput({ allow: ["vercel.com/badaaas"], mode: "lend", lend: "me", start: "vercel.com/badaaas/settings" });
  assert.ok(lend.ok && lend.value.lend === "me" && lend.value.start === "https://vercel.com/badaaas/settings");
});

test("a share as agents and the page see it: links while it is open, a replay always", () => {
  const p = parseShareInput({ allow: ["sso.godaddy.com"] });
  assert.ok(p.ok);
  if (!p.ok) return;
  const s = newShare(p.value, bytes, { kind: "agent", id: "a1", name: "CTO" }, Date.parse("2026-11-09T10:00:00Z"));
  assert.equal(s.bot, `share-${s.id}`);
  assert.equal(s.exp, Math.floor(Date.parse("2026-11-11T10:00:00Z") / 1000));
  const d = describe(s, "https://os.example.com", key, { frames: 12 });
  assert.equal(d.link, shareLink("https://os.example.com", key, s));
  assert.match(d.link!, /^https:\/\/os\.example\.com\/_computer\/s\/[a-z2-7]{12}\.\d{10}\.[a-f0-9]{32}$/);
  assert.equal(d.recording?.replay, replayLink("https://os.example.com", key, s));
  assert.deepEqual(readReplayToken(key, d.recording!.replay.split("/").at(-1)!, s.exp + 10 * 86400)?.id, s.id, "the replay outlives the link");
  s.status = "ended";
  assert.equal(describe(s, "https://os.example.com", key).link, null);
});

test("keeping a sign-in: only for login links, sites as hosts, kept computers' ids", async () => {
  const { hostsFrom, keepNotice, keptId } = await import("../src/shares.ts");
  const r = parseShareInput({ allow: ["sso.godaddy.com", "dcc.godaddy.com/control/*"], keep: "new:Acme GoDaddy" });
  assert.ok(r.ok && r.value.keep === "new:Acme GoDaddy");
  assert.match((parseShareInput({ allow: ["x.com"], mode: "lend", lend: "me", keep: "new:X" }) as { error: string }).error, /only for "login"/);
  assert.deepEqual(hostsFrom(["https://dcc.godaddy.com/control/*", "*.godaddy.com", "sso.godaddy.com", "a*.b.com", "nodot"]), ["dcc.godaddy.com", "godaddy.com", "sso.godaddy.com"]);
  assert.equal(keptId("Acme – GoDaddy!", []), "shared-kept-acme-godaddy");
  assert.equal(keptId("Acme GoDaddy", ["shared-kept-acme-godaddy"]), "shared-kept-acme-godaddy-2");
  assert.match(keptId("Acme GoDaddy", []), /^shared-[a-z0-9-]{1,50}$/, "the same shape as settings' shared computers");
  assert.match(keepNotice("BadAaas"), /^BadAaas will keep this sign-in.*changing your password/);
});
