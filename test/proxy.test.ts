import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { checkProxy } from "../src/computer.ts";

/** A proxy that wants u:p, and a plain "what is my address" server behind it. */
async function rig() {
  const site = http.createServer((_q, s) => s.end("203.0.113.7"));
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const sitePort = (site.address() as net.AddressInfo).port;
  const proxy = http.createServer();
  proxy.on("connect", (req, client) => {
    if (req.headers["proxy-authorization"] !== "Basic " + Buffer.from("u:p").toString("base64")) return void client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    const r = net.connect(sitePort, "127.0.0.1", () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); r.pipe(client); client.pipe(r); });
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const port = (proxy.address() as net.AddressInfo).port;
  const target = { host: "whatismyip.test", port: 80, tls: false };
  return { port, target, close: () => { site.close(); proxy.close(); } };
}

test("a working proxy reports the address the world sees", async () => {
  const r = await rig();
  try { const c = await checkProxy(`http://u:p@127.0.0.1:${r.port}`, r.target); assert.equal(c.ok, true); assert.equal((c as { ip: string }).ip, "203.0.113.7"); }
  finally { r.close(); }
});

test("wrong password, nothing listening, and nonsense are explained", async () => {
  const r = await rig();
  try {
    assert.match((await checkProxy(`http://u:wrong@127.0.0.1:${r.port}`, r.target) as { error: string }).error, /username or password/);
    assert.match((await checkProxy("http://127.0.0.1:1", r.target) as { error: string }).error, /refused the connection/);
    assert.match((await checkProxy("socks5://h:1", r.target) as { error: string }).error, /not supported/);
  } finally { r.close(); }
});
