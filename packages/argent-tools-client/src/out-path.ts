/** Resolve and write a caller's `out` path, on the client that keeps the file. */

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/** An absolute path to write to, or the reason the request cannot be honored. */
export type OutPathResolution = { path: string } | { refusal: string };

/** Where the bytes landed, or why they did not. */
export type OutWriteResult = { wrote: string } | { failure: string };

/**
 * `~` never reaches an argument through a shell — an MCP arg is JSON, and the
 * CLI's only route to a tool's own `out` is JSON inside `--args`/`--out-json` —
 * so expand it here rather than creating a directory literally named `~` in the
 * agent's project.
 */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") || p.startsWith(`~${sep}`) ? join(homedir(), p.slice(2)) : p;
}

/** The final path segment, treating both `sep` and `/` as separators. */
function lastSegment(p: string): string {
  return p.split(sep).pop()!.split("/").pop()!;
}

/**
 * Where an image result's `out` should be written, on THIS host.
 *
 * Both clients that honor `out` share it so one parameter cannot mean two
 * things: `argent-mcp` writes it into a content block, `argent-cli` writes it
 * for `--out` and for a tool's own `out` property. It returns an absolute path
 * because that is the spelling the caller has to be able to hand onward —
 * `screenshot-diff` resolves a relative `baselinePath` against the tool-server's
 * working directory, not the client's.
 */
export function resolveOutPath(out: string): OutPathResolution {
  const trimmed = out.trim();
  if (!trimmed) return { refusal: "out names no path." };
  const expanded = expandTilde(trimmed);
  // `resolve` collapses a trailing separator, `.` and `..`, so each of those
  // spellings names a DIRECTORY that would otherwise land as a regular FILE of
  // that name and block every later write underneath it.
  const last = lastSegment(expanded);
  if (last === "" || last === "." || last === "..") {
    return { refusal: "out names the file to write, not a directory." };
  }
  return { path: resolve(expanded) };
}

/**
 * Write `data` to the caller's `out`, creating missing parents.
 *
 * Staged through a sibling temp file and renamed into place, so `out` only ever
 * holds a whole capture: a truncating write leaves a half-written PNG there when
 * it fails midway, and the destination is a file the caller intends to diff
 * against later, where a truncated baseline scores as a difference rather than
 * an error. Rename also makes two clients racing one `out` resolve to one
 * capture or the other instead of a byte-level mix of both.
 */
export async function writeOutFile(out: string, data: Buffer): Promise<OutWriteResult> {
  const resolved = resolveOutPath(out);
  if ("refusal" in resolved) return { failure: `Could not save to ${out}: ${resolved.refusal}` };
  const target = resolved.path;
  const staged = `${target}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(staged, data);
    await rename(staged, target);
    return { wrote: target };
  } catch (err) {
    await rm(staged, { force: true }).catch(() => {});
    return {
      failure: `Could not save to ${target}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
