import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { server } from "../src/server/server";

let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const pin = readFileSync(join(__dirname, "..", "examples", "synthetic-pin.json"), "utf8");
const post = (path: string, body: string, type = "application/json") => fetch(base + path, { method: "POST", headers: { "content-type": type }, body });

describe("server API (no solver started in tests)", () => {
  it("ping reports no solver when the distro was not initialised", async () => {
    const j: any = await (await fetch(base + "/api/ping")).json();
    expect(j.ok).toBe(true);
    expect(j.solver).toBeNull();
  });

  it("POST /api/run without a solver is 503 with a plain message", async () => {
    const r = await post("/api/run", pin);
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).error).toMatch(/No solver is installed/);
  });

  it("POST /api/check validates and returns the quick look", async () => {
    const j: any = await (await post("/api/check", pin)).json();
    expect(j.ok).toBe(true);
    expect(j.quick.temperatures.centreT).toBeCloseTo(1308.2542, 3);
  });

  it("rejects non-JSON content types and bad bodies", async () => {
    expect((await post("/api/check", pin, "text/plain")).status).toBe(415);
    expect((await post("/api/check", "{nope")).status).toBe(400);
  });

  it("run ids that are not 12 hex characters never reach the run manager", async () => {
    for (const bad of ["../../etc/passwd", "ZZZZZZZZZZZZ", "abc", "..%2f..%2fx"]) expect((await fetch(base + "/api/run/" + bad)).status).toBe(404);
  });

  it("unknown routes are 404", async () => {
    expect((await fetch(base + "/api/nothing")).status).toBe(404);
  });
});
