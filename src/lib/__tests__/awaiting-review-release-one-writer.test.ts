import fs from "node:fs";
import path from "node:path";
import { BookingStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { activeLifecycleEditRefusal } from "@/lib/booking-edit-policy";

/**
 * #3500: ONLY THE OFFICER REVIEW ROUTE RELEASES `AWAITING_REVIEW` TO
 * `PAYMENT_PENDING` (`INV-MOD-013`).
 *
 * Until this issue the guest-add route carried a branch that would release a
 * parked booking to `PAYMENT_PENDING` when adding an adult cleared the review,
 * and `booking-modify-plan.ts`, `booking-guest-removal-service.ts` and
 * `booking-modify-settlement.ts` carried the same fiction as a
 * `releaseFromReview` flag. None of it could run. Three of the four sit behind
 * an edit door that has refused `AWAITING_REVIEW` since the day the branch was
 * written (`booking-edit-eligibility-one-home.test.ts` pins that refusal for
 * every role, so this file does not pin it again — it reads the same helper
 * once, below, to name the door it leans on). The removal arm is the exception:
 * a linked guest's SELF-removal skips that door and `AWAITING_REVIEW` is in
 * `SELF_REMOVABLE_GUEST_BOOKING_STATUSES`, so it does reach
 * `resolveRemovalReviewUpdate` — and was still dead, because a no-adult park is
 * all-minor (any surviving subset stays flagged) and a request hold carries
 * `heldBookingId`, which `assertBookingNotQuotePriced` refuses first
 * (`booking-guest-consent-authority.test.ts` pins the status staying put). The
 * owner's decision on #3500 deleted the four arms rather than opening a door,
 * so the next reader is not told a self-service route out of review exists.
 *
 * WHAT THIS CENSUS SEES. It reads every non-test `.ts`/`.tsx` under `src/` with
 * comments stripped (`stripComments`, the one stripper in the tree) and looks
 * for three SHAPES of a status write of `PAYMENT_PENDING` conditioned on
 * `AWAITING_REVIEW`:
 *
 *  - a ternary whose condition names `AWAITING_REVIEW` and whose consequent is
 *    `PAYMENT_PENDING` — the shape the guest-add arm had;
 *  - an `if`/`else if` whose condition names `AWAITING_REVIEW` and whose block
 *    assigns `PAYMENT_PENDING` — the shape the settlement arm had;
 *  - a boolean bound from an `AWAITING_REVIEW` comparison and then used as the
 *    condition of a ternary with a `PAYMENT_PENDING` consequent — the shape the
 *    officer route's status-guarded claim uses (`parkedForReview`).
 *
 * The third shape is what makes the census POSITIVE: it must find the officer
 * route, so a detector that silently stopped matching anything reads as a
 * failure rather than a pass. WHAT IT CANNOT SEE, stated because a guard that
 * claims more than it catches is itself the defect (`INV-SSOT-004`): a `switch`;
 * a lookup map from status to status; a release written across two statements
 * with no shared boolean; or an `updateMany` whose `where` names the status in
 * a variable. Measured before the decision: the two deleted arms match the
 * first two shapes, and nothing else in the tree matches any of them.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

const OFFICER_REVIEW_ROUTE = "src/app/api/admin/bookings/[id]/review/route.ts";
const GUEST_ADD_ROUTE = "src/app/api/bookings/[id]/guests/route.ts";
const FORMER_RELEASE_ARMS = [
  GUEST_ADD_ROUTE,
  "src/lib/booking-modify-plan.ts",
  "src/lib/booking-guest-removal-service.ts",
  "src/lib/booking-modify-settlement.ts",
];

const read = (relative: string): string => {
  const absolute = path.join(REPO_ROOT, relative);
  // A census that cannot find its subject is a false green, not a pass.
  expect(fs.existsSync(absolute), `${relative} must exist`).toBe(true);
  return fs.readFileSync(absolute, "utf8");
};

function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walkSources(absolute, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(absolute);
    }
  }
  return out;
}

const AWAITING = String.raw`(?:BookingStatus\.AWAITING_REVIEW|"AWAITING_REVIEW")`;
const PAYMENT = String.raw`(?:BookingStatus\.PAYMENT_PENDING|"PAYMENT_PENDING")`;

/** `cond-naming-AWAITING_REVIEW ? PAYMENT_PENDING` with no `;`, `{` or `:` between. */
const TERNARY_ARM = new RegExp(
  String.raw`${AWAITING}[^;{}:?]*\?\s*(?:\{\s*status:\s*)?${PAYMENT}`,
);

/** `if (... AWAITING_REVIEW ...) { ... PAYMENT_PENDING ... }` within one block. */
const IF_ARM = new RegExp(
  String.raw`if\s*\([^)]*${AWAITING}[^)]*\)\s*\{[^}]*${PAYMENT}`,
);

/** `const flag = ... AWAITING_REVIEW;` then `flag ? ... PAYMENT_PENDING`. */
function boundFlagArms(source: string): string[] {
  const found: string[] = [];
  const binding = new RegExp(
    String.raw`(?:const|let)\s+(\w+)\s*=[^;]*${AWAITING}[^;]*;`,
    "g",
  );
  for (const match of source.matchAll(binding)) {
    const flag = match[1];
    const use = new RegExp(
      String.raw`\b${flag}\b\s*\?\s*(?:\{\s*status:\s*)?${PAYMENT}`,
    );
    if (use.test(source)) found.push(flag);
  }
  return found;
}

function releaseWritersIn(relative: string, raw: string): string[] {
  const source = stripComments(raw);
  const hits: string[] = [];
  if (TERNARY_ARM.test(source)) hits.push(`${relative}: ternary arm`);
  if (IF_ARM.test(source)) hits.push(`${relative}: if-block arm`);
  for (const flag of boundFlagArms(source)) {
    hits.push(`${relative}: bound flag \`${flag}\``);
  }
  return hits;
}

describe("#3500: AWAITING_REVIEW -> PAYMENT_PENDING has one writer (INV-MOD-013)", () => {
  it("the guest-add door refuses AWAITING_REVIEW, so the deleted release arm could never have run", () => {
    // The refusal itself is pinned for every role and status by
    // booking-edit-eligibility-one-home.test.ts; this reads it once to name the
    // door the census below leans on.
    for (const role of ["MEMBER", "ADMIN"]) {
      expect(activeLifecycleEditRefusal(BookingStatus.AWAITING_REVIEW, role)).not.toBeNull();
    }
  });

  it("the guest-add route still clears a flagged review in place, without touching the status", () => {
    const source = stripComments(read(GUEST_ADD_ROUTE));
    const clearing = source.indexOf(
      "const reviewCleared = booking.requiresAdminReview && !requiresAdminReview;",
    );
    expect(clearing, "in-place review clearing survives (INV-ADDPAY-003)").toBeGreaterThan(-1);
    const block = source.slice(clearing, clearing + 1200);
    expect(block).toContain("requiresAdminReview: false");
    expect(block).toContain("adminReviewStatus: null");
    // The status written is the hold-adjusted one, never a review release.
    expect(block).toContain("status: holdAdjustedStatus");
    expect(block).not.toMatch(/AWAITING_REVIEW/);
  });

  it("no module outside the officer review route writes PAYMENT_PENDING conditioned on AWAITING_REVIEW", () => {
    const files = walkSources(SRC_ROOT);
    expect(files.length, "the census population is non-empty").toBeGreaterThan(100);
    for (const former of FORMER_RELEASE_ARMS) {
      expect(
        files.map((f) => path.relative(REPO_ROOT, f).split(path.sep).join("/")),
        `${former} is inside the population the census reads`,
      ).toContain(former);
    }

    const hits = files.flatMap((absolute) => {
      const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
      return releaseWritersIn(relative, fs.readFileSync(absolute, "utf8"));
    });

    expect(
      hits,
      "the detector must see the officer route's status-guarded claim; an empty census is a broken census, not a clean tree",
    ).toContain(`${OFFICER_REVIEW_ROUTE}: bound flag \`parkedForReview\``);
    expect(
      hits,
      "only the officer review route may release AWAITING_REVIEW to PAYMENT_PENDING (#3500, INV-MOD-013) — an edit door cannot reach that status, so a release arm there is fiction",
    ).toEqual([`${OFFICER_REVIEW_ROUTE}: bound flag \`parkedForReview\``]);
  });

  it("the releaseFromReview flag is gone from every former carrier", () => {
    for (const relative of FORMER_RELEASE_ARMS) {
      expect(stripComments(read(relative)), relative).not.toContain("releaseFromReview");
    }
  });
});
