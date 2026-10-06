import { describe, expect, it } from "vitest";
import { cancelArgs, runArgs, toWslPath } from "../src/core/wslBackend";

describe("WSL invocation (Codex finding #6): no default Linux shell between Node and the script", () => {
  const a = runArgs("C:\\proj\\solver\\run-feed.sh", "C:\\proj\\runs\\abc\\inputs", "C:\\proj\\runs\\abc\\native", "abcdef012345", 295);
  it("uses --exec, not '--'", () => {
    expect(a).toContain("--exec");
    expect(a).not.toContain("--");
  });
  it("starts bash explicitly with the script then the arguments, one array element each", () => {
    const i = a.indexOf("--exec");
    expect(a.slice(i + 1, i + 3)).toEqual(["bash", "/mnt/c/proj/solver/run-feed.sh"]);
    expect(a.slice(i + 3)).toEqual(["/mnt/c/proj/runs/abc/inputs", "/mnt/c/proj/runs/abc/native", "abcdef012345", "295"]);
  });
  it("keeps hostile path characters literal as single elements (apostrophe, dollar, backtick, space)", () => {
    const w = runArgs("C:\\O'Brien $HOME `id`\\solver\\run-feed.sh", "C:\\a b\\in", "C:\\a b\\out", "abcdef012345", 10);
    expect(w).toContain("/mnt/c/O'Brien $HOME `id`/solver/run-feed.sh");
    expect(w).toContain("/mnt/c/a b/in");
  });
  it("cancel uses --exec too and passes the run id", () => {
    const c = cancelArgs("C:\\proj\\solver\\cancel-feed.sh", "abcdef012345");
    expect(c).toContain("--exec");
    expect(c).not.toContain("--");
    expect(c.slice(c.indexOf("--exec"))).toEqual(["--exec", "bash", "/mnt/c/proj/solver/cancel-feed.sh", "abcdef012345"]);
  });
  it("toWslPath refuses a relative path", () => {
    expect(() => toWslPath("solver\\run-feed.sh")).toThrow(/absolute Windows path/);
  });

  // Supported path classes (F0 exit review): an absolute drive-letter path with either slash and any characters, spaces included.
  // Everything else is refused up front, with the same error, rather than passed to wsl.exe to fail there.
  it("toWslPath accepts drive-letter paths (either slash, either case, spaces) and nothing else", () => {
    expect(toWslPath("C:\\Users\\a b\\x")).toBe("/mnt/c/Users/a b/x");
    expect(toWslPath("d:/work/x")).toBe("/mnt/d/work/x");
    for (const bad of ["\\\\wsl$\\feed-solver\\home\\feed\\x", "\\\\server\\share\\x", "\\\\?\\C:\\x", "//wsl$/feed-solver/x", "/mnt/c/x", "C:x", "C:", "", "~/x"]) {
      expect(() => toWslPath(bad), bad).toThrow(/absolute Windows path/);
    }
  });
});
