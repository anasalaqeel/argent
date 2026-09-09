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
const NEGATION = String.raw`(?:do(?:es|id)?n't |do(?:es|id)? not |cannot |can't |could not |couldn't |must not |mustn't |should not |shouldn't |will not |won't |never |no longer |rather than |is not |isn't |are not |aren't |was not |wasn't |were not |weren't |not )`;
// One character of the run between a guard and what it guards. It may not cross
// into another clause, in either direction: one clause over, a negation is about
// a different claim, and so is a platform. Every separator this repo writes a
// clause break with, the comma and all three of its dashes included.
const SAME_CLAUSE = String.raw`(?:(?! - )[^.,;:—–()\[\]\n])`;
// The negation is not always against the verb ("it is not enough to just
// relaunch it"), so the guard reaches over the words between them. Without the
// clause limit the recovery's own vocabulary excuses the sentence it introduces:
// "the exit cannot be confirmed, so relaunch it anyway" is the advice this list
// exists to catch, written in the words the guidance itself uses.
const NEGATED = NEGATION + String.raw`${SAME_CLAUSE}{0,32}`;
// Between the tool and the platform, a fronted phrase is not a second claim -
// "On Chromium, use restart-app" is one clause - but everything longer past a
// comma is: "use restart-app, which is refused on Chromium" and "on Chromium,
// boot-device only starts an app, so use restart-app" both name a second subject
// there. So a comma may be crossed, and then only a few words.
const WITHIN_CLAUSE = String.raw`(?:${SAME_CLAUSE}{0,40}|,\s?${SAME_CLAUSE}{0,8})`;

const FORBIDDEN: [RegExp, string][] = [
  // `anyway` is one wording of it; the rest are what a shortening rewrite
  // reaches for.
  [
    new RegExp(
      String.raw`(?<!${NEGATED})(?:relaunch (?:it |the app )?(?:anyway|regardless)|` +
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
      String.raw`(?<!${NEGATED})(?:ignore|skip|disregard|do not follow|don't follow) ` +
        String.raw`(?:the |its |that )?\`?guidance|\`?guidance\`? is (?:stale|wrong|out of date)\b`,
      "i"
    ),
    "discarding the guidance the surface routes to",
  ],
  [
    new RegExp(
      String.raw`(?<!${NEGATED})(?:keep using|reuse|re-use) (?:it|the old|that|the|your) `,
      "i"
    ),
    "reusing an id across a relaunch",
  ],
  [
    new RegExp(
      String.raw`(?<!${NEGATED})(?:boot|launch) (?:it|the app) again|(?<!${NEGATED})call boot-device again`,
      "i"
    ),
    "booting an app that is still up",
  ],
  [
    new RegExp(
      String.raw`(?<!${NEGATED})(?:does mean|means|proves|confirms|shows|indicates) (?:that )?the app (?:exited|is gone)`,
      "i"
    ),
    "reading an exit off a missing list-devices entry",
  ],
  [
    new RegExp(
      String.raw`(?<!${NEGATED})(?:relaunch(?:ed)? (?:it |the app )?with|\buse) ` +
        String.raw`\`?restart-app\`?${WITHIN_CLAUSE}chromium`,
      "i"
    ),
    "restart-app on Chromium",
  ],
  [
    new RegExp(
      String.raw`chromium${WITHIN_CLAUSE}(?<!${NEGATED})` +
        String.raw`(?:relaunch(?:ed)? (?:it |the app )?with|\buse) \`?restart-app`,
      "i"
    ),
    "restart-app on Chromium",
  ],
  // A "so" clause inherits the topic of the sentence it hangs off, so the platform
  // and the instruction can sit clauses apart and still be one claim - and every
  // barred sentence of that shape is built out of the recovery's own words ("on
  // Chromium boot-device only starts an app, so use restart-app").
  [
    new RegExp(
      String.raw`chromium[^.]{0,80}\bso (?:you (?:can |should )?)?` +
        String.raw`(?:use|call) \`?restart-app`,
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
