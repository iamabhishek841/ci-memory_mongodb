import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { getHost } from "./config.js";
import { createApiServer } from "./http.js";

test("hosted writes require a key and accept the configured HTTPS origin", async () => {
  const previous = { NODE_ENV: process.env.NODE_ENV, HOST: process.env.HOST, PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN, DEMO_WRITE_TOKEN: process.env.DEMO_WRITE_TOKEN };
  process.env.NODE_ENV = "production";
  delete process.env.HOST;
  process.env.PUBLIC_ORIGIN = "https://ci-memory.example.test";
  process.env.DEMO_WRITE_TOKEN = "ci-memory-test-access-key-32-bytes";
  assert.equal(getHost(), "0.0.0.0");
  let calls = 0;
  const server = createApiServer(async () => { calls++; throw new Error("Test execution boundary reached."); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const body = JSON.stringify({ scenario: "billing", scope: "shared" });
  try {
    const config = await (await fetch(`${base}/app-config`)).json();
    assert.deepEqual(config, { writeEnabled: true, writeAccessRequired: true });
    assert.ok(!JSON.stringify(config).includes(process.env.DEMO_WRITE_TOKEN));
    const withoutKey = await fetch(`${base}/runs`, { method: "POST", headers: { "Content-Type": "application/json", Origin: process.env.PUBLIC_ORIGIN }, body });
    assert.equal(withoutKey.status, 401);
    assert.equal(calls, 0);
    const headers = { "Content-Type": "application/json", Origin: process.env.PUBLIC_ORIGIN, Authorization: `Bearer ${process.env.DEMO_WRITE_TOKEN}` };
    const accepted = await fetch(`${base}/runs`, { method: "POST", headers, body });
    assert.equal(accepted.status, 503); // Authorized request reaches the deliberately unavailable test executor.
    assert.equal(calls, 1);
    const wrongOrigin = await fetch(`${base}/runs`, { method: "POST", headers: { ...headers, Origin: "https://other.example.test" }, body });
    assert.equal(wrongOrigin.status, 403);
    assert.equal(calls, 1);
    delete process.env.DEMO_WRITE_TOKEN;
    const readOnly = await fetch(`${base}/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert.equal(readOnly.status, 403);
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
