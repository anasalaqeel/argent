import { expect } from "vitest";

/**
 * The instructions the Chromium recovery exists to prevent. A pin counts what a
 * surface SAYS; nothing in one stops the opposite being appended after it, and
 * the appended sentence is the one a reader acts on last. Shared so the runtime
 * guidance strings and the prose surfaces are held to one list rather than two
 * that can drift apart.
 *
 * Each pattern matches the ACT, and a `NEGATED` prefix excuses it — the surfaces
 * that state these correctly all say them in the negative, so a pattern keyed on
 * one deleted negation fires on its own synthetic mutation and on nothing else,
 * while turning correct prose red.
 */
// The auxiliary is optional so "cannot BE relaunched with" negates as readily
// as "cannot relaunch with" — the surfaces use both.
const NEGATED = String.raw`(?:do(?:es)?n't |do(?:es)? not |cannot |can't |must not |never |is not |are not |not )(?:be |been )?`;

const FORBIDDEN: [RegExp, string][] = [
  // `anyway` is one wording of it; the rest are what a shortening rewrite
  // reaches for. Every pattern here takes the NEGATED guard, and it spans a
  // short run of words: the negation is not always adjacent ("it is not enough
  // to just relaunch it"), and without the span that correct sentence fires.
  [
    new RegExp(
      String.raw`(?<!${NEGATED}[^.]{0,24})(?:relaunch (?:it |the app )?(?:anyway|regardless)|` +
        String.raw`(?:just|simply) relaunch)`,
      "i"
    ),
    "relaunching without the exit confirmed",
  ],
  // The five prose surfaces exist to route the reader to one copy of the
  // recovery. Naming the field and then discarding it is the shape that leaves
  // every routing pin green while inverting what the surface tells the reader —
  // "do not follow the guidance" contains the phrase the pin looks for.
  [
    new RegExp(
      String.raw`(?<!${NEGATED}[^.]{0,24})(?:ignore|skip|disregard|do not follow|don't follow) ` +
        String.raw`(?:the |its )?\`?guidance|\`?guidance\`? is (?:stale|wrong|out of date)\b`,
      "i"
    ),
    "discarding the guidance the surface routes to",
  ],
  [
    new RegExp(
      String.raw`(?<!${NEGATED})(?:keep using|reuse|re-use) (?:it|the old|that|the) `,
      "i"
    ),
    "reusing an id across a relaunch",
  ],
  [
    new RegExp(
      String.raw`(?<!${NEGATED})(?:boot|launch) it again|(?<!${NEGATED})call boot-device again`,
      "i"
    ),
    "booting an app that is still up",
  ],
  [
    new RegExp(
      String.raw`(?<!${NEGATED})(?:does mean|means|proves|confirms) (?:that )?the app (?:exited|is gone)`,
      "i"
    ),
    "reading an exit off a missing list-devices entry",
  ],
  [
    new RegExp(
      String.raw`(?<!${NEGATED})(?:relaunched? (?:it )?with|use) \`?restart-app\`?[^.]{0,40}chromium`,
      "i"
    ),
    "restart-app on Chromium",
  ],
  [
    new RegExp(
      String.raw`chromium[^.]{0,40}(?<!${NEGATED})relaunch(?:ed)? (?:it )?with \`?restart-app`,
      "i"
    ),
    "restart-app on Chromium",
  ],
  // The windowless arm's remedy is a window, and every surface that names the
  // state sits next to a block whose standing instruction is a relaunch.
  [
    new RegExp(String.raw`(?<!${NEGATED})relaunch (?:it |the app )?there\b`, "i"),
    "relaunching an app that only lacks a window",
  ],
];

export function expectNoForbiddenAdvice(text: string | undefined, label: string) {
  for (const [pattern, what] of FORBIDDEN)
    expect(text ?? "", `${label} must not advise ${what}`).not.toMatch(pattern);
}
