// The localhost server can start processes, so it must refuse requests that did not come from its own page:
// wrong Host (DNS rebinding), cross-origin or header-less state changes. (Codex finding #2.)
import { AddressInfo } from "net";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { request } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { server, useManager } from "../src/server/server";
import { FakeBackend } from "./helpers/fakeBackend";

let port = 0;
let runsRoot = "";
const pin = readFileSync(join(__dirname, "..", "examples", "synthetic-pin.json"), "utf8");

/** Raw request so the Host header can be set freely (fetch forbids it). */
function raw(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: t }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const goodHost = () => "127.0.0.1:" + port;

beforeAll(async () => {
  runsRoot = mkdtempSync(join(tmpdir(), "feed-sec-"));
  useManager(new RunManager({ runsRoot, backend: new FakeBackend("good") }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  useManager(null);
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(runsRoot, { recursive: true, force: true });
});

describe("Host header", () => {
  for (const host of [() => "evil.test:" + port, () => "evil.test", () => "127.0.0.1:1", () => "127.0.0.1", () => "localhost.evil.test:" + port, () => "[::2]:" + port]) {
    it("refuses a GET with Host '" + host() + "'", async () => {
      const r = await raw("GET", "/api/ping", { host: host() });
      expect(r.status).toBe(403);
      expect(r.body).toMatch(/host/i);
    });
  }
  for (const host of [() => "127.0.0.1:" + port, () => "localhost:" + port, () => "[::1]:" + port]) {
    it("accepts a GET with Host '" + host() + "'", async () => {
      expect((await raw("GET", "/api/ping", { host: host() })).status).toBe(200);
    });
  }
  it("refuses a request with no Host header at all (HTTP/1.0 lets one through Node's own check)", async () => {
    const { connect } = await import("net");
    const reply = await new Promise<string>((resolve, reject) => {
      const s = connect(port, "127.0.0.1", () => s.write("GET /api/ping HTTP/1.0\r\n\r\n"));
      let t = "";
      s.on("data", (c) => (t += c));
      s.on("end", () => resolve(t));
      s.on("error", reject);
    });
    expect(reply).toMatch(/^HTTP\/1\.\d 403/);
  });
  it("refuses a bad Host on every route, including the page, results and CSV", async () => {
    for (const p of ["/", "/api/runs", "/api/library", "/api/run/000000000000/results.csv", "/api/compare?a=000000000000&b=000000000000"]) {
      expect((await raw("GET", p, { host: "evil.test:" + port })).status, p).toBe(403);
    }
  });
});

describe("state-changing requests", () => {
  const json = { "content-type": "application/json", "x-feed-client": "1" };
  it("refuses POST /api/run without the client header (a cross-site page cannot add it without a CORS preflight)", async () => {
    const r = await raw("POST", "/api/run", { host: goodHost(), "content-type": "application/json" }, pin);
    expect(r.status).toBe(403);
  });
  it("refuses a cross-origin cancel posted as a form", async () => {
    const r = await raw("POST", "/api/run/000000000000/cancel", { host: goodHost(), origin: "http://evil.test", "content-type": "application/x-www-form-urlencoded" });
    expect(r.status).toBe(403);
  });
  it("refuses a POST whose Origin is another site even with the header", async () => {
    const r = await raw("POST", "/api/run", { ...json, host: goodHost(), origin: "http://evil.test" }, pin);
    expect(r.status).toBe(403);
  });
  it("refuses a POST whose Origin is the right host on another port", async () => {
    const r = await raw("POST", "/api/run", { ...json, host: goodHost(), origin: "http://127.0.0.1:1" }, pin);
    expect(r.status).toBe(403);
  });
  it("refuses a POST with Origin 'null' (sandboxed or file pages)", async () => {
    const r = await raw("POST", "/api/run", { ...json, host: goodHost(), origin: "null" }, pin);
    expect(r.status).toBe(403);
  });
  it("accepts the page's own POST: right Host, same Origin, client header", async () => {
    const r = await raw("POST", "/api/run", { ...json, host: goodHost(), origin: "http://" + goodHost() }, pin);
    expect(r.status).toBe(202);
  });
  it("accepts a POST with no Origin (a script or curl on this machine) when it sends the header", async () => {
    const r = await raw("POST", "/api/check", { ...json, host: goodHost() }, pin);
    expect(r.status).toBe(200);
  });
  it("a refused POST does not start a run", async () => {
    const before = await raw("GET", "/api/runs", { host: goodHost() });
    await raw("POST", "/api/run", { host: goodHost(), origin: "http://evil.test", "content-type": "application/json" }, pin);
    const after = await raw("GET", "/api/runs", { host: goodHost() });
    expect(JSON.parse(after.body).length).toBe(JSON.parse(before.body).length);
  });
});
