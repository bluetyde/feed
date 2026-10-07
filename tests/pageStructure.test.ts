// The editor page's accessible structure, read from the static HTML (the parts a screen reader navigates by). The live checks (names of the generated
// fields, the plot tables, the announcements) were done in a browser: docs/accessibility.md.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const html = readFileSync(join(__dirname, "..", "src", "web", "index.html"), "utf8");
const body = html.slice(html.indexOf("<body"), html.indexOf("<script"));
const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);

describe("the page's static accessible structure", () => {
  it("has a language, a title, one main landmark, a skip link to it, and one level-1 heading", () => {
    expect(html).toMatch(/<html[^>]*\blang="en"/);
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(body.match(/<main\b/g)?.length).toBe(1);
    expect(body).toMatch(/<a class="skip" href="#center">/);
    expect(body).toMatch(/<main[^>]*\bid="center"/);
    expect(body.match(/aria-level="1"/g)?.length).toBe(1);
  });

  it("has no duplicate ids", () => {
    expect(ids.filter((x, i) => ids.indexOf(x) !== i)).toEqual([]);
  });

  it("every tab that names a panel names one that exists and is a tab panel", () => {
    const tabs = [...body.matchAll(/<button[^>]*role="tab"[^>]*aria-controls="([^"]+)"/g)].map((m) => m[1]!);
    expect(tabs.length).toBeGreaterThanOrEqual(4);
    for (const id of tabs) expect(body, id).toMatch(new RegExp(`<div[^>]*\\bid="${id}"[^>]*role="tabpanel"|<div[^>]*role="tabpanel"[^>]*\\bid="${id}"`));
  });

  it("every canvas has a name, and every decorative icon in a button is hidden", () => {
    for (const m of body.matchAll(/<canvas\b[^>]*>/g)) expect(m[0], m[0]).toMatch(/aria-label="[^"]+"/);
    for (const m of body.matchAll(/<button[^>]*>\s*(<svg\b[^>]*>)/g)) expect(m[1], m[1]).toMatch(/aria-hidden="true"/);
  });

  it("writes a values table beside every plot, announces the validation outcome, and makes section titles headings", () => {
    expect(html).toMatch(/function plotText\(/);
    for (const draw of ["drawProfile", "drawTimeSeries", "drawGeneric", "drawDelta"]) {
      const start = html.indexOf(`function ${draw}(`);
      expect(start, draw).toBeGreaterThan(0);
      const next = html.indexOf("\nfunction ", start + 10);
      const calls = [...html.slice(start, next < 0 ? undefined : next).matchAll(/plotText\([^\r\n]*\);/g)].map((m) => m[0]);
      expect(
        calls.filter((c) => !c.includes('"", "", [])')),
        draw,
      ).not.toEqual([]); // a call that writes data, not only the one that clears the table
    }
    expect(html).toMatch(/function closeMenu\(\)[^\r\n]*opener\.focus\(\)/); // a closed menu gives the focus back to its button
    expect(body).toMatch(/id="announce"[^>]*aria-live="polite"|aria-live="polite"[^>]*id="announce"/);
    expect(html).toMatch(/function elt\([^\r\n]*psec[^\r\n]*setAttribute\("role", "heading"\)/); // the helper that builds most section titles
    expect(html.match(/el\("div", "psec"\); h2?\.setAttribute\("role", "heading"\)/g)?.length).toBe(2); // the two built by hand
  });
});
