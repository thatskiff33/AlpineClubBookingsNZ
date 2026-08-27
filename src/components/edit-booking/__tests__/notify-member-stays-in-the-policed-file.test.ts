import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Comments are stripped before the sweep below: raw text cannot tell a call site
// from prose about one, and the module comments in this subtree quote the very
// expressions being matched.
import { stripComments } from "@/lib/__tests__/support/strip-comments";

/*
  #2690 — the "No emails" honesty rule has one structural blind spot, and this
  split is what put a participant behind it.

  THE BLIND SPOT, measured rather than assumed. The shared closed-world census in
  `src/components/__tests__/booking-no-emails-ui-contract.test.ts` is what stops a
  new "email the member?" prompt joining neither of its two declared lists. Its
  walk collects `.tsx` files ONLY. Measured both ways while writing this guard: a
  `.tsx` module that returns `{ notifyMember: … }` fails that census, and the
  byte-identical file renamed to `.ts` passes it silently.

  WHY THAT MATTERS HERE. Before #2690 the whole edit surface was one `.tsx` file,
  so the question could not arise. The split created `hooks/use-hosting-coverage-
  override.ts` — a `.ts` module that holds the officer's `notifyMemberChoice` and
  hands it back to the save path. Nothing escapes today: the choice is only ever
  turned into a payload key by `edit-booking-panel.tsx`, which is on
  `BOOKING_NOTIFY_PROMPTS` and carries all four of that census's per-file checks.
  But "nothing escapes today" is a fact about the current code, not a property of
  it, and the next module added to this folder is one keystroke from being a
  notify prompt the shared census cannot see.

  So this guard is deliberately LOCAL and deliberately narrow: it fences this one
  subtree, where the risk was created, and leaves the shared census's walk alone.
  Widening that walk to `.ts` is a bigger, separate question — it would enrol
  every server module in the repository that names the flag — and it needs its own
  measurement rather than a drive-by change on a refactor PR.

  WHERE THE LINE IS. The guard matches the payload key `notifyMember`, not the
  local variable `notifyMemberChoice` that carries an officer's already-made
  decision between two functions. Holding the choice is not offering it, and
  `use-hosting-coverage-override.ts` legitimately does the former: it stores the
  choice that was made when a save was refused, so retrying the SAME proposal
  re-sends the SAME decision rather than silently asking again.
*/

const SUBTREE = join(process.cwd(), "src", "components", "edit-booking");
const PANEL = join(process.cwd(), "src", "components", "edit-booking-panel.tsx");

/** The payload key the route reads. Not `notifyMemberChoice` — see the note above. */
const NOTIFY_MEMBER_KEY = /\bnotifyMember\b/;

/**
 * The extensions this repository treats as production source, kept in step with
 * `scripts/lib/file-size-budget.ts`. Narrower than that set is a blind spot, and
 * a blind spot is what this fence exists to close.
 */
const POLICED_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;

/** Every non-test `.ts`/`.tsx` file in the subtree. */
function subtreeFiles(dir = SUBTREE, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      subtreeFiles(full, out);
      continue;
    }
    // Every extension the ratchet treats as production, not just .ts/.tsx.
    // This fence exists because the shared #2259 census walks .tsx only, so the
    // byte-identical file renamed to .ts slips past it — and a .tsx?-only walk
    // here would reproduce that same hole one extension over. Next serves
    // .js/.jsx by default, tsconfig sets allowJs and names .mts, and every
    // custom lint rule block is scoped to .ts/.tsx under src, so a .js file
    // there is policed by nothing at all. See scripts/lib/file-size-budget.ts,
    // which widened to this exact set for the same reason.
    if (
      POLICED_EXTENSIONS.test(entry.name) &&
      !/\.test\.[cm]?[jt]sx?$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("the edit-booking split does not hide a notify prompt from the #2259 census", () => {
  it("scans a subtree that actually exists, so a tree move cannot pass vacuously", () => {
    const files = subtreeFiles();
    expect(
      files.length,
      "the edit-booking subtree was not found; this guard is checking nothing",
    ).toBeGreaterThan(15);
  });

  it("keeps the payload key out of every module in the subtree", () => {
    const offenders = subtreeFiles()
      .filter((file) => NOTIFY_MEMBER_KEY.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => relative(process.cwd(), file).split(sep).join("/"));

    expect(
      offenders,
      "A module under src/components/edit-booking/ names the `notifyMember` " +
        "payload key. The shared closed-world census in " +
        "booking-no-emails-ui-contract.test.ts walks `.tsx` files only, so a " +
        "`.ts` module here would carry an email-the-member decision that the " +
        "#2259 honesty rule cannot see. Keep the decision in " +
        "edit-booking-panel.tsx, which that census polices, or classify the new " +
        "surface there explicitly.",
    ).toEqual([]);
  });

  it("proves the decision still lives in the file the shared census polices", () => {
    // The other half of the rule, and what stops it passing by deletion: if the
    // notify dialog ever left the panel, the check above would go green while
    // the honesty rule lost its subject entirely.
    const panel = stripComments(readFileSync(PANEL, "utf8"));
    expect(NOTIFY_MEMBER_KEY.test(panel)).toBe(true);
    expect(readFileSync(PANEL, "utf8")).toContain("BookingNoEmailsNotice");
  });
});
