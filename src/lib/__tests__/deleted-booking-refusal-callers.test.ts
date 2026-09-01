// #2700 — who may say "cancelled or removed", and where in the handler they may
// say it, read off the real source files.
//
// ENFORCES INV-ADDPAY-034 (docs/invariants/additional-payment-chasing.md), which
// names three surfaces and states that the disclosure is safe ONLY because the
// guard sits below the authorisation check on every one of them. Both halves of
// that rule were prose until this file existed: `deleted-booking-refusal.ts`
// asserted in its own docblock that "every caller of this module places the
// check AFTER its authorisation check" and that only three surfaces use it, and
// nothing anywhere failed when a fourth one did neither.
//
// WHY STRUCTURAL AND NOT BEHAVIOURAL. The three shipped surfaces already have
// behavioural tests, and every one of them passes unchanged the day a FOURTH
// route imports the constant and places it above its own ownership check. That
// is the failure this file exists for, and it is not hypothetical: the precedent
// INV-ADDPAY-031 itself records is `send-guest-payment-link`, which consulted
// `deletedAt` before its authorisation check and shipped that way until #2674
// reordered it — handing anyone holding a guessed booking id a "deleted versus
// live" oracle. Now that the repo has NORMALISED an informative body on this
// hazard, importing the constant is the easy thing to do and inheriting the
// ordering decision by import is the easy mistake.
//
// Mirrors the sweep convention in adult-member-hosting-call-sites.test.ts
// (#2569) and subscription-lockout-call-sites.test.ts (#2543).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { stripComments } from "./support/strip-comments";

const REFUSAL_MODULE = "src/lib/deleted-booking-refusal.ts";

/**
 * The three surfaces INV-ADDPAY-034 names, plus the module that defines the
 * sentence. Any other file appearing here has taken an ordering decision nobody
 * reviewed.
 */
const APPROVED_IMPORTERS = [
  "src/app/api/bookings/[id]/change-requests/route.ts",
  "src/app/api/bookings/[id]/refund-request/route.ts",
  "src/lib/member-guest-consent-service.ts",
].sort();

function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/**
 * The same source with its comments removed.
 *
 * Every sweep below is a claim about CODE, and this repository comments heavily
 * — the refusal module's own docblock names all three surfaces in prose, and
 * both route files explain the ordering in prose above the guard. A plain text
 * search reads all of that as call sites and the assertions become the opposite
 * of what they say.
 */
function readRepoCode(relativePath: string): string {
  return stripComments(readRepoFile(relativePath));
}

/**
 * Every non-test source file under `src/` that IMPORTS the refusal module, as
 * sorted repo-relative POSIX paths.
 *
 * Keyed on the import specifier rather than on the exported names, so aliasing
 * on the way in (`DELETED_BOOKING_MESSAGE as MESSAGE`) does not slip past. The
 * module's own file is excluded — it defines the names rather than importing
 * them.
 */
function refusalModuleImporters(): string[] {
  const root = path.resolve(process.cwd(), "src");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
        continue;
      }
      const relative = path.relative(process.cwd(), full).split(path.sep).join("/");
      if (relative === REFUSAL_MODULE) continue;
      if (/from\s*"@\/lib\/deleted-booking-refusal"/.test(readRepoCode(relative))) {
        found.push(relative);
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * The body of one top-level function, from its declaration to the next
 * top-level declaration (or the end of the file).
 *
 * Scoped per function on purpose: "an authorisation refusal appears somewhere
 * earlier in the file" is not the claim. `change-requests/route.ts` carries a
 * POST whose 403 sits hundreds of lines above the GET, so a file-wide check
 * would pass for a GET that never authorised anybody at all.
 */
function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `${declaration} not found`).toBeGreaterThan(-1);
  const rest = source.slice(start + declaration.length);
  const next = rest.search(/\n(?:export\s+)?(?:async\s+)?function\s/);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Assert `guard` appears strictly after `authorisation` inside one function.
 *
 * Both indexes are the FIRST occurrence, which is the conservative reading: a
 * guard placed above the first 403 fails even if a second 403 happens to sit
 * above a second guard.
 */
function expectGuardBelowAuthorisation(params: {
  file: string;
  declaration: string;
  authorisation: RegExp;
  guard: RegExp;
}) {
  const body = functionBody(readRepoCode(params.file), params.declaration);
  const authorisationAt = body.search(params.authorisation);
  const guardAt = body.search(params.guard);

  expect(
    authorisationAt,
    `${params.file} :: ${params.declaration} no longer refuses an unauthorised caller before it reaches the deleted-booking guard`,
  ).toBeGreaterThan(-1);
  expect(
    guardAt,
    `${params.file} :: ${params.declaration} no longer carries a deleted-booking guard`,
  ).toBeGreaterThan(-1);
  expect(
    guardAt,
    `INV-ADDPAY-034: ${params.file} :: ${params.declaration} says "cancelled or removed" BEFORE it has refused an unauthorised caller. That turns the endpoint into a deleted-versus-live oracle for anyone holding a guessed booking id — the exact defect #2674 had to reorder out of send-guest-payment-link. Move the guard below the authorisation check.`,
  ).toBeGreaterThan(authorisationAt);
}

describe("deleted-booking refusal callers (#2700, INV-ADDPAY-034)", () => {
  it("actually walked the tree, so a broken sweep cannot pass as a clean census", () => {
    // Without this, a path change makes the walk return nothing and the
    // allowlist assertion below passes against an empty set.
    expect(readRepoCode(REFUSAL_MODULE)).toContain("DELETED_BOOKING_MESSAGE");
    expect(refusalModuleImporters().length).toBeGreaterThan(0);
  });

  it("is imported by exactly the three surfaces INV-ADDPAY-034 names, and nothing else", () => {
    expect(
      refusalModuleImporters(),
      'A file outside INV-ADDPAY-034\'s three surfaces imports the shared "cancelled or removed" sentence. That is not a lint failure to silence by widening this list: INV-ADDPAY-031 says a deleted-booking 404 body must be byte-identical to the ordinary not-found body, and #2700 departed from that on exactly three surfaces because the guard provably sits below their authorisation check. A fourth caller must take that ordering decision explicitly — read INV-ADDPAY-031 and INV-ADDPAY-034, add the surface to APPROVED_IMPORTERS with its own ordering assertion below, and say in the PR why disclosure is safe there.',
    ).toEqual(APPROVED_IMPORTERS);
  });

  it("puts the change-requests GET guard below its 403", () => {
    expectGuardBelowAuthorisation({
      file: "src/app/api/bookings/[id]/change-requests/route.ts",
      declaration: "export async function GET(",
      authorisation: /status:\s*403/,
      guard: /deletedBookingRefusalResponse\(\)/,
    });
  });

  it("puts the refund-request GET guard below its 403", () => {
    expectGuardBelowAuthorisation({
      file: "src/app/api/bookings/[id]/refund-request/route.ts",
      declaration: "export async function GET(",
      authorisation: /status:\s*403/,
      guard: /deletedBookingRefusalResponse\(\)/,
    });
  });

  it("puts the consent guard below the target/delegate check, where the route cannot host it", () => {
    // The one surface whose guard is NOT in a route file, and deliberately so:
    // the route's pre-read proves only that the guest row belongs to the
    // booking, so a check there would answer 404-versus-403 to somebody holding
    // a guessed pair of ids (INV-ADDPAY-035).
    expectGuardBelowAuthorisation({
      file: "src/lib/member-guest-consent-service.ts",
      declaration: "export async function respondToMemberGuestConsent(",
      authorisation: /if\s*\(!isTarget\s*&&\s*!isDelegate\)\s*forbidden\(\)/,
      guard: /refuseDeletedBooking\(\)/,
    });
  });

  it("keeps the consent route itself free of the constant, so the uniform 403 cannot be undercut above the service", () => {
    // Not redundant with the allowlist: this is the SPECIFIC regression
    // INV-ADDPAY-035 forbids by name, and it names the file a future
    // contributor would reach for first.
    expect(
      refusalModuleImporters(),
      "INV-ADDPAY-035: the consent ROUTE must not carry the deleted-booking body. Its pre-read proves only that the guest row belongs to the booking, so a guard there hands a 404-versus-403 oracle to a caller holding two guessed ids. The guard belongs in member-guest-consent-service.ts, below the target/delegate check.",
    ).not.toContain("src/app/api/bookings/[id]/guests/[guestId]/consent/route.ts");
  });
});
