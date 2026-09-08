import { describe, it, expect, afterEach } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { resolveOutPath } from "../src/out-path.js";

describe("resolveOutPath", () => {
  const realHome = process.env.HOME;
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  });

  it("returns an absolute path, so a relative `out` is never handed onward as typed", () => {
    const r = resolveOutPath("shots/base.png");
    expect(r).toEqual({ path: resolve(process.cwd(), "shots/base.png") });
  });

  it("leaves an absolute path alone", () => {
    const abs = join(tmpdir(), "base.png");
    expect(resolveOutPath(abs)).toEqual({ path: abs });
  });

  it("trims, so a padded value is not read as a relative path", () => {
    const abs = join(tmpdir(), "base.png");
    expect(resolveOutPath(`  ${abs}\n`)).toEqual({ path: abs });
  });

  // No shell stands between an agent and this argument, so `~` arrives literal.
  it("expands `~`", () => {
    process.env.HOME = join(tmpdir(), "fake-home");
    expect(resolveOutPath("~/base.png")).toEqual({ path: join(homedir(), "base.png") });
    expect(resolveOutPath("~")).toEqual({ path: homedir() });
  });

  it("does not expand a `~` that is not the whole first segment", () => {
    expect(resolveOutPath("~user/base.png")).toEqual({
      path: resolve(process.cwd(), "~user/base.png"),
    });
  });

  // `resolve` collapses all three, which would turn a directory the caller named
  // into a regular file of that name and block every later write underneath it.
  it.each([`${sep}`, `${sep}.`, `${sep}..`])("refuses a path ending in %j", (tail) => {
    expect(resolveOutPath(join(tmpdir(), "shots") + tail)).toEqual({
      refusal: "out names the file to write, not a directory.",
    });
  });

  it("refuses an empty or whitespace-only path", () => {
    expect(resolveOutPath("")).toEqual({ refusal: "out names no path." });
    expect(resolveOutPath("   ")).toEqual({ refusal: "out names no path." });
  });

  it("accepts a name that merely contains a dot", () => {
    expect(resolveOutPath(join(tmpdir(), "..base.png"))).toEqual({
      path: join(tmpdir(), "..base.png"),
    });
  });
});
