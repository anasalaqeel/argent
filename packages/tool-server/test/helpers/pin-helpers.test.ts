import { describe, it, expect } from "vitest";
import { expectNoForbiddenAdvice } from "./forbidden-advice";
import { pinsOnce } from "./pins";
import { CHROMIUM_WORDS, expectNoPlatformBeyondTag, platformTag } from "./platform-tag";

/**
 * The doc-pinning helpers only ever fail under a mutation, so nothing in a green
 * suite tells a weakened one from the real thing — a widened `FORBIDDEN` pattern
 * or a `CHROMIUM_WORDS` that lost a synonym leaves every caller passing. Their
 * contracts are asserted here directly.
 */
describe("pinsOnce", () => {
  it("requires exactly one occurrence", () => {
    pinsOnce("restart-app is not supported on chromium", "not supported on chromium");
    expect(() => pinsOnce("nothing here", "not supported on chromium")).toThrow();
    expect(() => pinsOnce("chromium chromium", "chromium")).toThrow();
  });
});

describe("CHROMIUM_WORDS", () => {
  it("matches every word this repo names a Chromium runtime with", () => {
    for (const cell of [
      "not supported on Chromium",
      "boot-device with electronAppPath relaunches an Electron app",
      "and on any CDP browser",
    ]) {
      expect(cell, cell).toMatch(CHROMIUM_WORDS);
    }
  });

  it("does not match a row that names no Chromium runtime", () => {
    expect("Relaunch by bundleId (iOS / Android / Vega)").not.toMatch(CHROMIUM_WORDS);
  });
});

describe("expectNoPlatformBeyondTag", () => {
  const tag = platformTag({ apple: { simulator: true }, android: { emulator: true } });

  it("accepts prose that claims only its tag", () => {
    expect(tag).toBe("iOS / Android");
    expectNoPlatformBeyondTag(`Full React fiber tree on ${tag} (names, depth)`, tag, "row");
  });

  it("rejects a platform claimed after the tag, however it is separated", () => {
    // `row()` hands this helper the whole markdown line, so a platform in a LATER
    // CELL is inside its reach and must fail — the separator is not the contract,
    // the cell's whole text is.
    for (const cell of [
      `Full React fiber tree on ${tag} (names), and on Vega.`,
      `| Reload | \`x\` (${tag}) | also on Vega |`,
      `(${tag}); plus Vega`,
      `(${tag}): also Vega`,
    ]) {
      expect(() => expectNoPlatformBeyondTag(cell, tag, "row"), cell).toThrow();
    }
  });
});

describe("expectNoForbiddenAdvice", () => {
  it("accepts prose that carries none of the barred instructions", () => {
    expectNoForbiddenAdvice(
      "Ask the user to quit it, then relaunch once it has exited. Do not relaunch there. " +
        "A Chromium app cannot be relaunched with `restart-app`.",
      "surface"
    );
    expectNoForbiddenAdvice(undefined, "absent surface");
  });

  it("accepts every ordinary way correct prose negates one", () => {
    // A pattern keyed on one deleted negation turns correct prose red with a
    // message accusing the author of the opposite. English has more than three
    // ways to say no, and the surfaces use them.
    for (const text of [
      "Don't relaunch there.",
      "You should not relaunch there.",
      "A Chromium app is not relaunched with restart-app.",
      "Never relaunch there.",
      "You cannot relaunch it with restart-app on Chromium.",
      "A missing entry does not mean the app exited.",
      "A missing entry never proves the app exited.",
      "An absent entry never confirms the app is gone.",
      "Do not keep using the old id.",
      "Do not relaunch it anyway.",
      "Do not just relaunch it.",
      "It is not enough to just relaunch it.",
      "It is never safe to simply relaunch a live app.",
      "Follow the guidance on its result.",
      "The guidance names the relaunch that works.",
      "Do not ignore the guidance debugger-status returns.",
      "Never ignore the guidance on the result.",
      "You cannot skip the guidance here.",
      // The negation is a clause away from the act, or spelled a way the
      // surfaces spell it.
      "Do not ever relaunch it there.",
      "A Chromium app isn't relaunched with restart-app.",
      "You won't reuse the old id.",
      "It is no longer relaunched with restart-app on Chromium.",
      // The refusal and the instruction are two clauses, so the platform named
      // in one is not the platform instructed in the other. Every restart-app
      // surface has to carry a sentence of this shape.
      "use restart-app — not supported on Chromium",
      "On iOS / Android / Vega, use `restart-app`; on Chromium it is refused.",
      "Use `restart-app` (not on Chromium) to relaunch it.",
    ])
      expectNoForbiddenAdvice(text, `correct: ${text}`);
  });

  it("rejects each barred instruction, in the shapes a rewrite actually produces", () => {
    for (const text of [
      "It may still be up — relaunch it anyway.",
      "Keep using the old chromium-cdp-<port> id.",
      "Reuse the chromium-cdp-<port> id you already have.",
      "If nothing is listed, boot it again.",
      "If nothing is listed, call boot-device again.",
      "A missing entry does mean the app exited.",
      "A missing entry means the app exited.",
      "An absent entry proves the app exited.",
      "On Chromium it is relaunched with restart-app.",
      "Use restart-app to relaunch a Chromium app.",
      "It only lacks a window, so relaunch there once.",
      "It only lacks a window — relaunch it there.",
      "Just relaunch it.",
      "It may still be up; just relaunch the app.",
      "Simply relaunch it once.",
      "Relaunch it regardless.",
      "debugger-status returns a guidance field, but ignore the guidance on Chromium.",
      "It returns a guidance field, but that guidance is stale here.",
      "Call debugger-status, but do not follow the guidance on its result.",
      "Read the result and skip the guidance.",
      "Disregard the guidance on Chromium.",
      "The guidance is out of date on Chromium.",
      // The imperative, which is how a rewrite states it.
      "Relaunch it with `restart-app` on Chromium.",
      "Relaunch the app with restart-app on Chromium.",
      // The negation one clause back is about a different claim - and it is the
      // recovery's own vocabulary, so this is what a shortening rewrite of it
      // produces.
      "The exit cannot be confirmed, so relaunch it anyway.",
      "The app is not listed, so just relaunch it.",
      "list-devices does not show it; just relaunch the app.",
      "debugger-status is not needed here, ignore the guidance.",
    ])
      expect(() => expectNoForbiddenAdvice(text, "surface"), text).toThrow();
  });
});
