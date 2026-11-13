/**
 * A FAMILY-DEDUP KEY FOR A MEMBERSHIP SUBSCRIPTION CHARGE IS BUILT IN ONE
 * PLACE (INV-SSOT-007, INV-MONEY-046).
 *
 * `chargeFamilyAxisKey`/`chargeAxisDisplayName` in
 * `src/lib/membership-charge-axis.ts` are the only place allowed to turn a
 * charge's `membershipTypeId`/`subscriptionCategoryId` pair into a dedup key
 * or a display name. The hazard this guards: once `membershipTypeId` became
 * nullable (a category-routed charge carries it null), a raw template
 * literal like `` `${charge.membershipTypeId}:family:${charge.familyGroupId}` ``
 * silently stringifies a null id to the literal text "null" — collapsing
 * every category charge for a family onto the SAME dedup key regardless of
 * which category it actually is. TypeScript does not flag this: `${x}`
 * typechecks for any `x`, including `null`.
 *
 * Scoped to the files that build these keys or render a charge's axis — the
 * billing engine, its closed-family vocabulary module, the Xero invoice
 * builder and the billing panel — rather than a repo-wide scan. Three shapes
 * are refused: a type id interpolated into a family key, any hand-built
 * family key, and a raw axis-column read with no fallback.
 *
 * Uses `stripComments`, not `stripCommentsAndStrings`: the hazard this
 * guards IS the literal text of a template literal (the `:family:` text
 * between two `${...}` interpolations), and `stripCommentsAndStrings`
 * replaces a whole template's static text with a single `""` placeholder,
 * discarding exactly the structure this scan needs to see — measured, it
 * turns a two-interpolation template into a bare `""` placeholder plus the
 * two interpolations' code, with no `:family:` text left to match at all.
 * `stripComments` copies string/template content through unchanged and
 * strips only line and block comments, which is what a scanner hunting for
 * real template-literal shape (rather than suppressing prose that merely
 * describes one) needs.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

/** The one file allowed to build this shape of key. */
const ACCESSOR = "src/lib/membership-charge-axis.ts";

/**
 * Every file that builds a charge key, renders a charge's axis, or reads a
 * charge back for an invoice or the billing panel.
 */
const SCANNED_FILES = [
  "src/lib/membership-subscription-billing.ts",
  "src/lib/subscription-charge-already-paid.ts",
  "src/lib/xero-subscription-invoices.ts",
  "src/app/(admin)/admin/finance/subscriptions/_components/subscription-billing-panel.tsx",
];

/**
 * `${...membershipTypeId...}:family:` or `.membershipTypeId}:family:` — a
 * template literal interpolating a type id directly into a family-dedup key,
 * rather than going through the accessor.
 */
// NOT a global regex. A global regex's `.test()` keeps `lastIndex` between
// calls, so reusing one `const` across many lines/strings (as the scan below
// and the fixture tests both do) alternates true/false on IDENTICAL input —
// measured: three calls on the same injected line returned true, false, true.
const RAW_FAMILY_KEY =
  /\$\{[^}]*membershipTypeId[^}]*\}\s*:\s*family\s*:|membershipTypeId\s*\}\s*:\s*family\s*:/;

/**
 * Any hand-built family key: `...}:family:` or `:family:${...`. Catches the
 * category id, a bare variable, or a key built from a different column, not
 * only a `membershipTypeId` interpolation (#4496 review: the first census
 * matched one template shape only).
 */
const ANY_FAMILY_KEY = /\}\s*:\s*family\s*:|:\s*family\s*:\s*\$\{/;

/**
 * A charge or entry's axis column interpolated straight into text, with no
 * `??` fallback: `${entry.membershipTypeName}`, `${charge.subscriptionCategoryId}`.
 * On the other axis the column is null and renders as "null" (the review's
 * "This family's null charge" warning). Use `chargeAxisDisplayName` for a
 * name and `chargeFamilyAxisKey` for a key.
 */
const RAW_AXIS_READ =
  /\$\{\s*[\w.?]*\.(?:membershipType(?:Id|Key|Name)|subscriptionCategory(?:Id|Key|Name))\s*\}/;

const PATTERNS = [RAW_FAMILY_KEY, ANY_FAMILY_KEY, RAW_AXIS_READ];

type Hit = { file: string; line: number; text: string };

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const file of SCANNED_FILES) {
    const source = stripComments(readFileSync(file, "utf8"));
    source.split("\n").forEach((text, index) => {
      if (PATTERNS.some((pattern) => pattern.test(text))) {
        hits.push({ file, line: index + 1, text: text.trim() });
      }
    });
  }
  return hits;
}

describe("a membership-charge family-dedup key is built in one place", () => {
  it("finds no raw family-key template literal outside the accessor", () => {
    const hits = scan();
    expect(
      hits.map((hit) => `${hit.file}:${hit.line} — ${hit.text.slice(0, 120)}`),
      `A family-dedup key is being built directly off membershipTypeId again, ` +
        `outside ${ACCESSOR}. Route it through chargeFamilyAxisKey() instead — ` +
        `a raw template literal silently stringifies a category charge's null ` +
        `membershipTypeId to the literal text "null", collapsing every ` +
        `category charge for a family onto the same key (INV-SSOT-007).`,
    ).toEqual([]);
  });

  it("FAILS when the old raw-template-literal shape appears (fixture proof)", () => {
    const injected = [
      "const key = `${input.seasonYear}:${charge.membershipTypeId}:family:${charge.familyGroupId}`;",
      "const key = `${input.seasonYear}:${membershipType.id}:family:${familyGroupId}`;".replace(
        "membershipType.id",
        "charge.membershipTypeId",
      ),
    ];
    for (const line of injected) {
      expect(RAW_FAMILY_KEY.test(line), `no hit for: ${line}`).toBe(true);
    }
  });

  it("FAILS on a hand-built category key or a raw axis-name read (fixture proof)", () => {
    const injected: Array<[RegExp, string]> = [
      [ANY_FAMILY_KEY, "const key = `${seasonYear}:category:${charge.subscriptionCategoryId}:family:${familyGroupId}`;"],
      [ANY_FAMILY_KEY, "const key = `${categoryId}:family:${familyGroupId}`;"],
      [RAW_AXIS_READ, "message: `This family's ${entry.membershipTypeName} charge was closed`,"],
      [RAW_AXIS_READ, "label: `${charge.subscriptionCategoryName} fee`,"],
      [RAW_AXIS_READ, "const id = `${charge?.membershipTypeId}`;"],
    ];
    for (const [pattern, line] of injected) {
      expect(pattern.test(line), `no hit for: ${line}`).toBe(true);
    }
  });

  it("does NOT fire on a display name resolved through the accessor or a fallback", () => {
    const routed = [
      "const name = chargeAxisDisplayName({ membershipTypeName: entry.membershipTypeName, subscriptionCategoryName: entry.subscriptionCategoryName ?? null });",
      "message: `${subscriptionCategory.name} has no effective subscription fee`,",
      "message: `for ${entry.membershipTypeName ?? entry.subscriptionCategoryName} `,",
    ];
    for (const line of routed) {
      expect(PATTERNS.some((pattern) => pattern.test(line)), `false hit for: ${line}`).toBe(false);
    }
  });

  it("does NOT fire on a call into the accessor", () => {
    const routed = [
      "const key = chargeFamilyAxisKey({ seasonYear, familyGroupId, membershipTypeId, subscriptionCategoryId });",
      "const key = chargeFamilyAxisKey(charge);",
    ];
    for (const line of routed) {
      expect(RAW_FAMILY_KEY.test(line), `false hit for: ${line}`).toBe(false);
    }
  });

  it("scans the files that have ever had a reason to build this key", () => {
    // A walker that silently scanned zero files would make the assertion
    // above vacuous.
    for (const file of SCANNED_FILES) {
      expect(() => readFileSync(file, "utf8")).not.toThrow();
    }
    expect(SCANNED_FILES.length).toBeGreaterThan(0);
  });
});
