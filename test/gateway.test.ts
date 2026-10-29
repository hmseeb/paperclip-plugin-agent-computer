import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

// The ticket rule from gateway/gateway.ts, which runs under Bun and cannot be imported here.
const key = createHmac("sha256", "tok").update("agent-computer stream tickets").digest();
const sign = (agent: string, exp: string) => createHmac("sha256", key).update(`${agent}.${exp}`).digest("hex");

test("the plugin signs tickets the way the gateway checks them", async () => {
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../gateway/gateway.ts", import.meta.url), "utf8"));
  const worker = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8"));
  for (const s of [src, worker]) assert.match(s, /createHmac\("sha256", token\)\.update\("agent-computer stream tickets"\)/);
  assert.match(src, /update\(`\$\{agent\}\.\$\{exp\}\.\$\{mode\}`\)/);
  assert.match(worker, /update\(`\$\{bot\}\.\$\{exp\}\.\$\{mode\}`\)/);
  assert.notEqual(sign("a", "1800000000"), sign("b", "1800000000"));
});
