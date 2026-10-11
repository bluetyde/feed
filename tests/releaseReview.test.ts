// Fixes from the whole-repo Codex review of 2026-10-11 (docs/reviews/codex-2026-10-11-release.md): the editor page cannot be framed, text from a case file goes into the page's
// HTML only through esc(), and write-case never deletes a folder it did not write.
import { AddressInfo } from "net";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { request } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { server } from "../src/server/server";

const root = join(__dirname, "..");
let port = 0;
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("the editor page", () => {
  it("cannot be framed by another page", async () => {
    const h = await new Promise<Record<string, string | string[] | undefined>>((resolve, reject) => {
      request({ host: "127.0.0.1", port, method: "GET", path: "/", headers: { host: "127.0.0.1:" + port } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.headers));
      })
        .on("error", reject)
        .end();
    });
    expect(h["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
  });
  it("puts a case's label, a stress limit's region, a refusal's text and a library revision into HTML only through esc()", () => {
    const html = readFileSync(join(root, "src/web/index.html"), "utf8");
    expect(html).toMatch(/const esc = \(s\) => String\(s\)\.replace\(\/&\/g, "&amp;"\)\.replace\(\/<\/g, "&lt;"\)\.replace\(\/>\/g, "&gt;"\)\.replace\(\/"\/g, "&quot;"\);/);
    expect(html).toContain('esc(doc.label || "")');
    expect(html).toContain("esc(l.region)");
    expect(html).toContain("esc(bad[0].problem)");
    expect(html).toContain("esc(cur.material.revision)");
    expect(html).not.toMatch(/"<code>" \+ \(doc\.label/);
  });
});

describe("write-case", () => {
  const run = (...args: string[]) => {
    try {
      execFileSync("node", [join(root, "dist/cli/write-case.js"), ...args], { stdio: "pipe" });
      return 0;
    } catch (e: any) {
      return e.status as number;
    }
  };
  const caseFile = join(root, "examples/synthetic-pin.json");
  it("refuses a folder that has files and is not one of its own, and leaves them alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "feed-wc-"));
    writeFileSync(join(dir, "marker.txt"), "mine");
    expect(run(caseFile, dir)).toBe(1);
    expect(readFileSync(join(dir, "marker.txt"), "utf8")).toBe("mine");
  });
  it("writes to a new or empty folder, and replaces a folder it wrote itself", () => {
    const base = mkdtempSync(join(tmpdir(), "feed-wc-"));
    const out = join(base, "case");
    expect(run(caseFile, out)).toBe(0);
    expect(existsSync(join(out, "feed-manifest.json"))).toBe(true);
    writeFileSync(join(out, "stale.txt"), "old");
    expect(run(caseFile, out)).toBe(0);
    expect(existsSync(join(out, "stale.txt"))).toBe(false);
    expect(existsSync(join(out, "system/controlDict"))).toBe(true);
  });
});
