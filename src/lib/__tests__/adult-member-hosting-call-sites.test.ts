// #2569 — the hosting policy's call sites, read off the real source files.
//
// ENFORCES INV-HOST-020 and INV-HOST-030
// (`docs/invariants/adult-member-hosting.md`), both of which name this file:
// INV-HOST-020 pins the school/organisation REVIEW_ONLY exemption to one site
// tree-wide, and INV-HOST-030 asserts who uses each confirming seam and that no
// confirming write uses neither. The census assertions for those two repeat the
// id in their failure message, so whoever trips one is handed the rule rather
// than having to go and find it (#2691).
//
// WHY STRUCTURAL AND NOT BEHAVIOURAL. Four of this issue's requirements are claims
// about a SET OF FILES rather than about an answer, and a behavioural test of the
// sites that exist today passes just as green when a new one is added:
//
//   * "one canonical server-side resolver" (§6) is a claim that quote calculation,
//     confirmation, payment completion, waitlist promotion, group joins,
//     modification, officer approval and member previews do NOT each carry their
//     own copy of the inheritance rule. A second copy gives identical answers right
//     up to the day a club overrides one dimension and inherits the other;
//   * "the school and organisation carve-out, and only that" (§13) is a claim that
//     exactly one call site passes `REVIEW_ONLY`. A second one, added for a reason
//     that felt local, silently exempts a member-owned flow from a refusal the club
//     switched on — and nothing in the exempted path's own tests would notice. This
//     lane found one: the MEMBER whole-lodge approval had been exempted under the
//     §13 comment, and a member booking the whole lodge for their own party is not a
//     school, an organisation, a teacher or a custodian;
//   * "every refusing surface hands back an answer the caller can act on" is
//     positional: `AdultMemberHostingRequiredError` extends `ApiError`, so a route
//     that catches it BELOW its generic branch answers a bare 409 with no code, no
//     frozen violation and no exception door, and looks fine in review;
//   * "the create path reads the policy before it opens its transaction" gives the
//     same answer wherever it sits — it just holds the per-lodge capacity lock
//     while doing it, which is the pool-starvation shape the booking rules forbid.
//
// Plus one that is not a requirement but a trap this lane walked into: Prisma's
// `select` is NOT typechecked for unknown keys through the narrow `Pick<PrismaClient,
// ...>` interface these paths use, so a renamed column in the policy loader's select
// is a runtime failure on every booking write path with a green typecheck.
//
// Mirrors the convention in subscription-lockout-call-sites.test.ts (#2543).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/**
 * The same source with its comments removed.
 *
 * Every sweep below is a claim about CODE, and this repository comments heavily —
 * `booking-request.ts` explains in prose that the school path passes
 * `enforcement: "REVIEW_ONLY"`, and the officer routes explain in prose that they
 * deliberately send no `exceptionRequestPath`. A plain text search reads both as
 * call sites and the assertions become the opposite of what they say.
 *
 * Block comments and whole-line `//` comments only: a trailing comment on a line of
 * code is left alone rather than risking a `//` inside a string literal.
 */
/**
 * Memoised, because the sweeps below are quadratic without it. `sourceFilesNaming`
 * walks every non-test source file under `src/` for ONE identifier, and each seam
 * or catcher inventory is its own walk — so without a cache a file is read and
 * comment-stripped once per sweep rather than once per run. Adding the fourth
 * `ENQUEUE_SEAMS` entry took the drain assertion from ~830 ms to over 9 s under
 * parallel load and blew vitest's 5 s default, while still passing when this file
 * was run alone: a timeout that only appears under load is the worst kind, because
 * CI may or may not catch it. Keyed by repo-relative path; the tree does not
 * change mid-run.
 *
 * The key is NORMALISED to forward slashes (#2623 F8). `sourceFilesNaming` builds
 * its paths with `path.relative`, which yields backslashes on Windows, while every
 * direct call site here passes a forward-slash literal — so the same file cached
 * under two keys and was read and stripped twice. Harmless but pointless, and
 * invisible on Linux CI, which is exactly the kind of divergence that makes a
 * local timing measurement disagree with CI's.
 */
const repoCodeCache = new Map<string, string>();

function readRepoCode(relativePath: string): string {
  const key = relativePath.split(path.sep).join("/");
  const cached = repoCodeCache.get(key);
  if (cached !== undefined) return cached;
  const code = readRepoFile(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
  repoCodeCache.set(key, code);
  return code;
}

/**
 * The name this file binds the SHARED `ApiError` to, or null if it does not import
 * it. Two routes carry a LOCAL class of the same name and alias the shared one, so
 * an ordering assertion written against the bare identifier compares a typed
 * refusal against a branch that can never catch it.
 */
function sharedApiErrorName(source: string): string | null {
  const match = source.match(
    /import\s*\{[^}]*\bApiError(?:\s+as\s+(\w+))?[^}]*\}\s*from\s*"@\/lib\/api-error"/,
  );
  if (!match) return null;
  return match[1] ?? "ApiError";
}

/**
 * Every non-test source file under `src/` that names `identifier`, as sorted
 * repo-relative POSIX paths.
 *
 * For assertions of the form "this belongs to exactly these paths". A hand-listed
 * set of files is not that assertion: it passes when a NEW site starts using the
 * thing, which is the only way the claim can ever be broken. Tests are excluded
 * because they legitimately name whatever they assert about.
 */
function sourceFilesNaming(identifier: string): string[] {
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
      if (readRepoCode(path.relative(process.cwd(), full)).includes(identifier)) {
        found.push(path.relative(process.cwd(), full).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  return found.sort();
}

describe("one authoritative evaluator and one resolver (#2569 §6, §7)", () => {
  it("resolves the club/lodge inheritance in exactly five places, none of them a booking path", () => {
    // The pure resolver (its own definition), the loader every booking write path
    // goes through, the admin card's effective view, the policy-change reconciler,
    // and the public booking-rules sentence. A booking path appearing here would be
    // a SECOND implementation of the inheritance rule — the thing §6 forbids by name.
    expect(sourceFilesNaming("resolveAdultMemberHostingPolicy(")).toEqual([
      "src/app/api/admin/booking-policies/adult-member-hosting/route.ts",
      "src/lib/adult-member-hosting-policy-reconciliation.ts",
      "src/lib/adult-member-hosting-review.ts",
      "src/lib/policies/adult-member-hosting.ts",
      "src/lib/public-page-content-tokens.ts",
    ]);
  });

  it("calls the pure evaluator only from the review service", () => {
    // §7: extend the shared evaluator, never write a second definition of a
    // qualifying adult member. Every caller reaches it through the review service,
    // which is also the only place that loads the participants.
    //
    // THE REVIEW SERVICE IS TWO MODULES SINCE #3128, and this list was widened
    // deliberately rather than to make a red test green. The engine answers for a
    // PERSISTED booking; `adult-member-hosting-proposed.ts` answers for a party
    // that does not exist yet, on the create path. It was always a separate
    // entry point with its own participant assembly — it simply used to sit in
    // the same file, and splitting a 3,051-line module moved it without changing
    // a line of it. §7's actual rule is unweakened by the widening: both callers
    // reach the ONE evaluator in `policies/adult-member-hosting.ts`, neither
    // decides for itself who qualifies, and a fourth namer still fails here and
    // still has to argue its case.
    expect(sourceFilesNaming("evaluateAdultMemberHostingWithPolicy(")).toEqual([
      "src/lib/adult-member-hosting-proposed.ts",
      "src/lib/adult-member-hosting-review.ts",
      "src/lib/policies/adult-member-hosting.ts",
    ]);
  });

  it("keeps the engine's newly-exported loaders inside the engine", () => {
    // #3128 had to widen four private helpers to `export` so the split modules
    // could reach them. Two of them read hosting rows and are only correct under
    // the caller's lock discipline, so a new caller elsewhere is a hazard the
    // move created and nothing else would catch. Pin them the way §7 pins the
    // evaluator: the list is short on purpose, and adding to it is a decision.
    expect(sourceFilesNaming("loadSameBookingOwnerHosts(")).toEqual([
      "src/lib/adult-member-hosting-proposed.ts",
      "src/lib/adult-member-hosting-review.ts",
    ]);
    expect(sourceFilesNaming("withSubscriptionSettlement(")).toEqual([
      "src/lib/adult-member-hosting-proposed.ts",
      "src/lib/adult-member-hosting-review.ts",
    ]);
  });

  it("selects exactly the host-scope columns the schema declares", () => {
    // The loader's `select` is narrowed, so an omitted scope column reads as "this
    // row did not decide" and quietly widens or narrows a lodge's rule — and a
    // STALE column name is a Prisma validation error on every booking write path
    // that typecheck does not catch (the db parameter is a hand-written
    // `Pick<PrismaClient, ...>`). Read off the schema so the two cannot drift.
    const schema = readRepoFile("prisma/schema.prisma");
    const declared = [
      ...new Set(
        [...schema.matchAll(/^\s*(hostScope\w+)\s+Boolean\?/gm)].map(
          (match) => match[1],
        ),
      ),
    ].sort();
    expect(declared).toEqual([
      "hostScopeSameBooking",
      "hostScopeSameBookingOwner",
    ]);

    const loader = readRepoCode("src/lib/adult-member-hosting-review.ts");
    const select = loader.slice(
      loader.indexOf("adultMemberHostingPolicy.findMany({"),
    );
    const window = select.slice(0, select.indexOf("});"));
    for (const column of declared) {
      expect(window, column).toContain(`${column}: true,`);
    }
    // And nothing that is not declared: a column deleted from the schema but left
    // here is the same runtime failure in reverse.
    const selected = [...window.matchAll(/(hostScope\w+):\s*true/g)]
      .map((match) => match[1])
      .sort();
    expect(selected).toEqual(declared);
  });
});

describe("combined member refusal and officer queue contracts", () => {
  it("keeps every authoritative host-qualification writer on the durable seam", () => {
    for (const file of [
      "src/app/api/admin/deletion-requests/[id]/route.ts",
      "src/app/api/admin/members/bulk-update/route.ts",
      "src/lib/admin-member-detail-service.ts",
      "src/lib/member-guest-consent-service.ts",
      "src/lib/manual-subscription-payment.ts",
      "src/lib/xero-membership-sync.ts",
    ]) {
      const source = readRepoCode(file);
      expect(source, file).toContain(
        "enqueueHostingCoverageReevaluationForMember(",
      );
      expect(source, file).toContain("settleHostingCoverageAfterCommit(");
    }
    const merge = readRepoCode("src/lib/member-merge.ts");
    expect(merge).toContain("buildMemberMergeHostingCoveragePlan(");
    expect(merge).toContain("enqueueMemberMergeHostingCoveragePlan(");
    expect(merge).toContain("settleHostingCoverageAfterCommit(");
  });

  it("returns both paid-up and hosting reasons through the redacted refusal shape", () => {
    for (const file of [
      "src/app/api/bookings/route.ts",
      "src/lib/group-booking.ts",
    ]) {
      const source = readRepoCode(file);
      expect(source, file).toContain(
        'code: "BOOKING_POLICY_REQUIREMENTS_NOT_MET"',
      );
      expect(source, file).toContain("reasonCodes:");
      expect(source, file).toMatch(
        /const hostingRefusal\s*=\s*buildAdultMemberHostingRefusalBody\(hostingViolation\)/,
      );
      expect(source, file).toContain("...hostingRefusal.violations");
      expect(source, file).toContain(
        "exceptionRequestPath: hostingRefusal.exceptionRequestPath",
      );
    }
  });

  it("puts unresolved incidents in the bookings permission area with direct rows", () => {
    const page = readRepoCode("src/app/(admin)/admin/bookings/page.tsx");
    expect(page).toContain('id="hosting-coverage-incidents"');
    expect(page).toContain("prisma.hostingCoverageIncident.count(");
    expect(page).toContain("prisma.hostingCoverageIncident.findMany(");
    expect(page.match(/resolvedAt:\s*null/g)).toHaveLength(2);
    expect(
      page.match(/\.\.\.\(query\.lodgeId \? \{ lodgeId: query\.lodgeId \} : \{\}\)/g),
    ).toHaveLength(2);
    expect(page).toContain("`/bookings/${incident.bookingId}`");

    const permissions = readRepoCode("src/lib/admin-permissions.ts");
    expect(permissions).toContain('area: "bookings"');
    expect(permissions).toContain('"/admin/bookings"');
  });
});

describe("the school and organisation carve-out, and only that (#2569 §13)", () => {
  it("passes REVIEW_ONLY from exactly one place: the school and organisation request approval", () => {
    // One site, because there is one such approval: `BookingRequestType.SCHOOL`
    // carries school groups and organisations alike, and `approveSchoolBookingRequest`
    // is the only path that approves them. The owner's exclusion names school and
    // organisation REQUEST APPROVALS and nothing else, so a second site — a
    // member-owned flow quietly exempted — would be a policy change made by a
    // one-line argument rather than by a decision.
    // TWO files, and the second is not a second carve-out. #2576's post-commit
    // coverage drain re-evaluates a booking that is ALREADY confirmed, so there is
    // nothing left to refuse — throwing there would abort a background sweep and
    // roll back the very incident it exists to record. It lives inside the review
    // service itself rather than at a flow, and the position assertion below pins
    // it to that one function, so it cannot become a way for a booking path to opt
    // out of an enforcing club's rule.
    expect(
      sourceFilesNaming('enforcement: "REVIEW_ONLY"'),
      "INV-HOST-020 (docs/invariants/adult-member-hosting.md): school and " +
        "organisation workflows are excluded from the hosting refusal, and only " +
        "they. A third file passing REVIEW_ONLY exempts a member-owned flow from " +
        "an enforcing club's rule by a one-line argument rather than by a decision.",
    ).toEqual([
      "src/lib/adult-member-hosting-review.ts",
      "src/lib/school-booking-request.ts",
    ]);
    const reviewService = readRepoCode("src/lib/adult-member-hosting-review.ts");
    expect(
      reviewService.match(/enforcement: "REVIEW_ONLY"/g) ?? [],
    ).toHaveLength(1);
    const incidentReconciler = reviewService.indexOf(
      "export async function reconcileSameOwnerCoverageIncident(",
    );
    expect(incidentReconciler).toBeGreaterThan(-1);
    expect(
      reviewService.indexOf('enforcement: "REVIEW_ONLY"'),
    ).toBeGreaterThan(incidentReconciler);
    const source = readRepoCode("src/lib/school-booking-request.ts");
    expect(source.match(/enforcement: "REVIEW_ONLY"/g) ?? []).toHaveLength(1);
    // And it is inside that approval rather than the MEMBER whole-lodge approval
    // further down the same file, which is deliberately not exempt (#2569 §2:
    // member-owned flows are in the first release; §13 is about teachers,
    // organisation leaders and custodians, none of which is a member booking the
    // whole lodge for their own party).
    const schoolApproval = source.indexOf(
      "export async function approveSchoolBookingRequest(",
    );
    const memberWholeLodge = source.indexOf(
      "export async function approveMemberWholeLodgeRequest(",
    );
    expect(schoolApproval).toBeGreaterThan(-1);
    expect(memberWholeLodge).toBeGreaterThan(schoolApproval);
    const site = source.indexOf('enforcement: "REVIEW_ONLY"');
    expect(site).toBeGreaterThan(schoolApproval);
    expect(site).toBeLessThan(memberWholeLodge);
    // The member whole-lodge approval still RECORDS the hazard; what changed is
    // that an enforcing lodge refuses it rather than approving into a review.
    expect(source.slice(memberWholeLodge)).toContain(
      "reconcileAdultMemberHostingReviewWithSiblings(booking.id, tx)",
    );
  });

  it("keeps the general public request approval inside the refusal", () => {
    // A public booking request is an all-non-member party owned by a non-login
    // contact, which is precisely the booking an enforcing lodge has said it will
    // not take. It reconciles with no enforcement argument, so it refuses.
    const source = readRepoCode("src/lib/booking-request.ts");
    expect(source).toContain(
      "reconcileAdultMemberHostingReviewWithSiblings(booking.id, tx)",
    );
    expect(source).not.toContain('enforcement: "REVIEW_ONLY"');
  });
});

describe("every refusing surface answers with something the caller can act on", () => {
  /**
   * Files that catch the refusal. Each must ALSO name the shape it answers with,
   * and the typed branch must come BEFORE any generic `ApiError` branch — the
   * refusal is a subclass, so below it the code, the frozen violation and the
   * exception door are all stripped.
   */
  const CATCHERS = sourceFilesNaming("instanceof AdultMemberHostingRequiredError");

  it("catches the refusal on every surface that can raise it, and nowhere else", () => {
    expect(CATCHERS).toEqual([
      "src/app/api/admin/booking-requests/[id]/approve/route.ts",
      "src/app/api/admin/booking-requests/[id]/hold/route.ts",
      // #2576 §9: confirming a DRAFT is a confirmation, and DRAFT is outside
      // `ACTIVE_BOOKING_STATUSES` — so it is invisible to the strand check that
      // guards a source cancellation, and this was the one confirming path where an
      // uncovered booking could reach PAID deterministically rather than by a race.
      "src/app/api/bookings/[id]/confirm-draft/route.ts",
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
      "src/app/api/bookings/[id]/guests/route.ts",
      "src/app/api/bookings/[id]/modify-dates/route.ts",
      "src/app/api/bookings/[id]/modify/route.ts",
      "src/lib/group-booking.ts",
      "src/lib/waitlist-cross-lodge.ts",
      "src/lib/waitlist.ts",
    ]);
  });

  it("answers with the exception-door body, or with a deliberate exception to it", () => {
    // Three surfaces deliberately do NOT return the rich body, and each has a
    // reason in its own comment: the two officer-facing request paths ARE the
    // authority the door leads to, and the verified NON-MEMBER group join is
    // confirmed from an emailed token with no session, so a body naming the club's
    // settings would be a policy read for anyone holding a token.
    const OFFICER_PATHS = [
      "src/app/api/admin/booking-requests/[id]/approve/route.ts",
      "src/app/api/admin/booking-requests/[id]/hold/route.ts",
    ];
    for (const file of CATCHERS) {
      const source = readRepoCode(file);
      if (OFFICER_PATHS.includes(file)) {
        expect(source, file).toContain("code: err.code");
        expect(source, file).not.toContain("exceptionRequestPath");
        continue;
      }
      expect(source, file).toContain("buildAdultMemberHostingRefusalBody(");
    }
    // The public non-member join carries the generic sentence INSTEAD, on the one
    // file that also builds the redacted body for the member join beside it.
    const groupBooking = readRepoCode("src/lib/group-booking.ts");
    expect(groupBooking).toContain(
      "PUBLIC_GROUP_JOIN_ADULT_MEMBER_HOSTING_MESSAGE",
    );
  });

  it("puts the typed branch above the generic ApiError branch", () => {
    for (const file of CATCHERS) {
      const source = readRepoCode(file);
      const shared = sharedApiErrorName(source);
      if (shared === null) continue;
      const generic = source.indexOf(`instanceof ${shared}`);
      if (generic === -1) continue;
      const typed = source.indexOf("instanceof AdultMemberHostingRequiredError");
      expect(typed, file).toBeGreaterThan(-1);
      expect(typed, file).toBeLessThan(generic);
    }
  });

  it("uses the waitlist sentence on the waitlist paths and nowhere else", () => {
    // The extra fact it adds — "your offer has not been used" — is true only where
    // a claim was rolled back. On a booking path there is no offer behind it, so
    // the sentence would send the member looking for something they do not have.
    expect(
      sourceFilesNaming("formatAdultMemberHostingWaitlistRefusal"),
    ).toEqual([
      "src/lib/policies/adult-member-hosting.ts",
      "src/lib/waitlist-cross-lodge.ts",
      "src/lib/waitlist.ts",
    ]);
  });
});

describe("the same-owner refusal and the escalation seam (#2576 §6, §8, §9)", () => {
  const REFUSAL_CATCHERS = sourceFilesNaming(
    "instanceof SameOwnerCoverageWouldBreakError",
  );

  it("catches the same-owner refusal on every member self-service surface", () => {
    // The five change classes §6 names that a member can reach: cancelling,
    // removing a guest, adding guests (which moves the night picture), a date
    // change and a batch edit. A path that raises it and does not catch it answers
    // a bare 409 with no list of the member's own affected bookings — which is the
    // whole content of the message.
    expect(REFUSAL_CATCHERS).toEqual([
      "src/app/api/bookings/[id]/cancel/route.ts",
      "src/app/api/bookings/[id]/confirm-draft/route.ts",
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
      "src/app/api/bookings/[id]/guests/route.ts",
      "src/app/api/bookings/[id]/modify-dates/route.ts",
      "src/app/api/bookings/[id]/modify/route.ts",
    ]);
  });

  it("answers with the structured body, above any generic ApiError branch", () => {
    // Same positional trap as its #2569 sibling: `SameOwnerCoverageWouldBreakError`
    // extends `ApiError`, so below a generic branch the member loses the booking
    // references, the lodge and the uncovered nights.
    for (const file of REFUSAL_CATCHERS) {
      const source = readRepoCode(file);
      expect(source, file).toContain("buildSameOwnerCoverageRefusalBody(");
      const shared = sharedApiErrorName(source);
      if (shared === null) continue;
      const generic = source.indexOf(`instanceof ${shared}`);
      if (generic === -1) continue;
      expect(
        source.indexOf("instanceof SameOwnerCoverageWouldBreakError"),
        file,
      ).toBeLessThan(generic);
    }
  });

  it("returns the state-bound override prompt from every officer-capable catcher", () => {
    const catchers = sourceFilesNaming(
      "instanceof SameOwnerCoverageOverrideRequiredError",
    );
    expect(catchers).toEqual([
      "src/app/api/admin/booking-exception-requests/[id]/route.ts",
      "src/app/api/bookings/[id]/cancel/route.ts",
      "src/app/api/bookings/[id]/confirm-draft/route.ts",
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
      "src/app/api/bookings/[id]/guests/route.ts",
      "src/app/api/bookings/[id]/modify-dates/route.ts",
      "src/app/api/bookings/[id]/modify/route.ts",
    ]);
    for (const file of catchers) {
      expect(readRepoCode(file), file).toContain(
        "buildSameOwnerCoverageOverrideRequiredBody(",
      );
    }
  });

  it("threads the state-bound retry through both admin shift dispatchers", () => {
    for (const file of [
      "src/app/api/bookings/[id]/modify/route.ts",
      "src/app/api/bookings/[id]/modify-dates/route.ts",
    ]) {
      const source = readRepoCode(file);
      const shift = source.slice(source.indexOf("await adminShiftBookingDates({"));
      expect(shift, file).toMatch(
        /adminShiftBookingDates\(\{[\s\S]*?hostingCoverageOverride:\s*parsed\.data\.hostingCoverageOverride/,
      );
    }
    const service = readRepoCode("src/lib/booking-date-modification-service.ts");
    const shiftService = service.slice(
      service.indexOf("export async function adminShiftBookingDates("),
    );
    expect(shiftService).toContain("actorMemberId: actor.id");
    expect(shiftService).toContain("override: hostingCoverageOverride");
  });

  it("uses the enqueue-only seam on exactly the confirming paths that must not refuse", () => {
    // §9 requires every confirming path to re-read the hosting facts. Most do it by
    // reconciling inside their own transaction, which REFUSES an uncovered booking at
    // an enforcing club. These cannot: capacity is claimed and money is in flight or
    // settled, so §8 applies instead — allow the transition, record the bounded
    // re-evaluation with it, escalate to an urgent incident afterwards.
    //
    // THIS LIST GREW BECAUSE THE FIRST VERSION OF IT WAS WRONG. It named five files
    // and read as though that were the whole confirming set, but the assertion only
    // pins who USES the seam — it cannot see a confirming path that uses NEITHER
    // seam, and five of them did not: the single payment settle door (whose payable
    // set includes DRAFT), the fully-credit-covered settlement, the inbound Xero
    // PAID, the admin waitlist force-confirm, and the group-settlement reaper's
    // CONFIRMED -> PAYMENT_PENDING revert, which de-confirms a coverage SOURCE.
    // `confirmingPathsUseAHostingSeam` below is the assertion that actually closes
    // that hole.
    expect(sourceFilesNaming("enqueueOwnHostingCoverageReevaluation(")).toEqual([
      "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts",
      "src/app/api/admin/bookings/[id]/force-confirm/route.ts",
      "src/app/api/bookings/[id]/waitlist-confirm/route.ts",
      "src/app/api/payments/switch-to-internet-banking/route.ts",
      "src/lib/adult-member-hosting-review.ts",
      "src/lib/booking-credit-election.ts",
      "src/lib/cron-confirm-pending.ts",
      "src/lib/cron-group-settlement-reaper.ts",
      "src/lib/group-settlement.ts",
      "src/lib/payment-reconciliation.ts",
      "src/lib/xero-inbound/invoice-paid-effects.ts",
    ]);
  });

  it("leaves no confirming write without a hosting seam at all (#2576 §9)", () => {
    // The assertion the census above could not make. Every file that claims a
    // booking into a confirmed-or-paid state must reach the hosting rule by one of
    // the two seams — reconcile (refuse) or enqueue (escalate) — because §9 forbids
    // relying on a quote-time answer, and the statuses these writes come FROM
    // (DRAFT, WAITLISTED, WAITLIST_OFFERED, PAYMENT_PENDING) are all outside
    // `ACTIVE_BOOKING_STATUSES` and therefore invisible to the strand check that
    // guards a source cancellation. A booking could be created while cover existed,
    // have that cover cancelled with nothing stranded and nothing queued, and then
    // confirm here with no refusal, no incident, no owner email and nothing in the
    // officer queue.
    const CONFIRMING_WRITES = [
      "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts",
      "src/app/api/admin/bookings/[id]/force-confirm/route.ts",
      "src/app/api/bookings/[id]/confirm-draft/route.ts",
      "src/app/api/bookings/[id]/waitlist-confirm/route.ts",
      "src/app/api/payments/switch-to-internet-banking/route.ts",
      "src/lib/booking-credit-election.ts",
      "src/lib/cron-confirm-pending.ts",
      "src/lib/group-settlement.ts",
      "src/lib/payment-reconciliation.ts",
      "src/lib/waitlist.ts",
      "src/lib/xero-inbound/invoice-paid-effects.ts",
    ];
    for (const file of CONFIRMING_WRITES) {
      const source = readRepoCode(file);
      const usesASeam =
        source.includes("enqueueOwnHostingCoverageReevaluation(") ||
        source.includes("reconcileAdultMemberHostingReviewWithSiblings(");
      expect(
        usesASeam,
        `INV-HOST-030 (docs/invariants/adult-member-hosting.md): ${file} claims a ` +
          "booking into a confirmed-or-paid state without reaching the hosting rule " +
          "by either seam — reconcile (refuse) or enqueue (escalate).",
      ).toBe(true);
    }
  });

  /**
   * The files that DEFINE the enqueue seams, plus the transaction-scoped helpers that
   * run inside somebody else's `tx` and so have no commit of their own to drain
   * after. Every other name reached by the sweep below would be a real gap.
   *
   * Shared by the two assertions that follow, because the exemption and the proof of
   * its premise have to be reading the same list — a helper exempted in one place and
   * unproven in the other is how the `member-guest-consent-service.ts` gap survived.
   */
  const TX_SCOPED_HELPERS = [
    "src/lib/adult-member-hosting-review.ts",
    // #3128 moved `enqueueMemberMergeHostingCoveragePlan`'s DECLARATION out of
    // the engine and into its own module. The engine was exempt here, the new
    // module was not, so the sweep began demanding that a pure planner drain a
    // queue it never commits — a false red produced by a move, on the one half
    // of this test #2623 F3 hardened for callers and not for declarations.
    "src/lib/adult-member-hosting-merge-coverage-plan.ts",
    "src/lib/booking-credit-election.ts",
    "src/lib/booking-guest-removal-service.ts",
    "src/lib/booking-exception-approval.ts",
  ];

  it("drains after the commit on every path that can record work", () => {
    // A queue row with nobody draining it is §7's "immediate re-evaluation" turned
    // into "within three hours": that long before an incident a new officer-created
    // booking has just fixed is resolved, or before one it caused is raised.
    //
    // TREE-WIDE, WHICH IS WHAT THE FIRST VERSION OF THIS TEST ONLY LOOKED LIKE. It
    // swept the enqueue users and then checked a HARDCODED list of five change
    // paths, so five other files that reconcile — and therefore can enqueue, because
    // `dependentCoverage` defaults to ESCALATE — sat outside the assertion entirely:
    // waitlist.ts, booking-request.ts, booking-request-quotes.ts, group-booking.ts
    // and school-booking-request.ts. The sweep below finds them by what they CALL.
    // #2623 T9(a): the merge plan seam belongs here too. Nothing escaped without
    // it — `member-merge.ts` is its only caller and is pinned separately above,
    // and it does drain — but the whole point of finding seam users by what they
    // CALL is that the NEXT caller is covered without anybody remembering to add
    // it to a list.
    const ENQUEUE_SEAMS = [
      "enqueueOwnHostingCoverageReevaluation(",
      "enqueueHostingCoverageReevaluationForMember(",
      "enqueueMemberMergeHostingCoveragePlan(",
      "reconcileAdultMemberHostingReviewWithSiblings(",
    ];
    const seamUsers = new Set<string>();
    for (const seam of ENQUEUE_SEAMS) {
      const users = sourceFilesNaming(seam);
      // A seam nobody calls contributes nothing, and a renamed seam left in this
      // list would degrade the sweep to the hardcoded list it replaced without
      // failing anything. Every entry has to be earning its place.
      //
      // NON-EMPTINESS IS TOO WEAK, and #2623 F3 found exactly where.
      // `sourceFilesNaming` matches any non-test file NAMING the identifier —
      // including the file that DECLARES it. Three of these four seams are
      // declared in `adult-member-hosting-review.ts`, which is also in
      // `TX_SCOPED_HELPERS` and so is skipped by the sweep below. So for
      // `enqueueMemberMergeHostingCoveragePlan(`, whose only real caller is
      // `member-merge.ts`, losing that caller would leave `users` as just the
      // declaration: non-empty, guard green, and `member-merge.ts` silently out
      // of the sweep — the exact regression this entry was added to prevent.
      // Discount the declaration and require a real CALLER. The declaring file
      // is found rather than hardcoded, so moving a seam to another module does
      // not quietly turn this back into the weaker check.
      const declaresSeam = `function ${seam.slice(0, -1)}(`;
      const callers = users.filter(
        (file) => !readRepoCode(file).includes(declaresSeam),
      );
      expect(
        callers,
        `${seam} has no caller outside its own declaration`,
      ).not.toEqual([]);
      for (const file of users) seamUsers.add(file);
    }
    for (const file of [...seamUsers].sort()) {
      if (TX_SCOPED_HELPERS.includes(file)) continue;
      expect(readRepoCode(file), file).toContain(
        "settleHostingCoverageAfterCommit(",
      );
    }
  });

  it("proves the carve-out's premise: every caller of a tx-scoped helper drains", () => {
    // THE CARVE-OUT ABOVE ASSERTS SOMETHING IT DOES NOT CHECK, and that unchecked
    // half is where a real gap hid. `booking-guest-removal-service.ts` is exempt on
    // the stated grounds that "its own callers drain" — and one of them did not:
    // `member-guest-consent-service.ts` routes a DECLINE and an EXPIRY through the
    // shared removal path, which reconciles and can enqueue, and then committed
    // without draining. §6 lists "removal or decline of required member-guest
    // consent" among the changes that must be re-evaluated, so the owner of a booking
    // that had just lost its cover waited up to three hours to be told.
    //
    // So the premise is now an assertion. A future helper added to the exempt list
    // brings its callers into this sweep automatically, which is the property the
    // hardcoded list never had.
    const EXPORTED_TX_ENTRYPOINTS: Record<string, readonly string[]> = {
      "src/lib/booking-guest-removal-service.ts": [
        "removeBookingGuestInTransaction(",
      ],
      "src/lib/booking-credit-election.ts": ["settleFullyCreditCoveredBooking("],
      "src/lib/booking-exception-approval.ts": [],
      // The seam definitions themselves; their callers are the sweep above.
      "src/lib/adult-member-hosting-review.ts": [],
      "src/lib/adult-member-hosting-merge-coverage-plan.ts": [],
    };
    for (const helper of TX_SCOPED_HELPERS) {
      const entrypoints = EXPORTED_TX_ENTRYPOINTS[helper];
      // A helper added to the exempt list without saying how it is entered would
      // silently opt its callers out of the whole invariant.
      expect(entrypoints, `${helper} has no declared entrypoints`).toBeDefined();
      for (const entrypoint of entrypoints ?? []) {
        for (const caller of sourceFilesNaming(entrypoint)) {
          if (caller === helper) continue;
          expect(
            readRepoCode(caller),
            `${caller} calls ${entrypoint} and must drain after its commit`,
          ).toContain("settleHostingCoverageAfterCommit(");
        }
      }
    }
  });

  it("never drains through a transaction client", () => {
    // The drain takes the module client by default. A call that handed it a `tx`
    // would read the uncommitted rows it exists to re-read, and would send email
    // from a transaction that can still roll back.
    for (const file of sourceFilesNaming("settleHostingCoverageAfterCommit(")) {
      const source = readRepoCode(file);
      for (const call of source.matchAll(
        /settleHostingCoverageAfterCommit\(([^)]*)\)/g,
      )) {
        // The argument is a scoping object (`{ bookingId }`, `{ limit }`) — never a
        // client. `\btx\b` still catches the mistake this exists to catch, because a
        // transaction client is only ever named `tx` here.
        expect(call[1].trim(), `${file}: ${call[0]}`).not.toMatch(/\btx\b/);
      }
    }
  });

  it("pins hosting and lock seams to the confirming branches that need them", () => {
    const adminConfirm = readRepoCode(
      "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts",
    );
    const adminZero = adminConfirm.slice(
      adminConfirm.indexOf("if (booking.finalPriceCents === 0)"),
      adminConfirm.indexOf("// No saved payment method"),
    );
    expect(adminZero).toContain(
      "reconcileBedAllocationsForBookingWithLodgeLockHeld({",
    );
    expect(adminZero).toContain("enqueueOwnHostingCoverageReevaluation(");
    expect(adminZero).toContain("settleHostingCoverageAfterCommit({ bookingId })");

    const cron = readRepoCode("src/lib/cron-confirm-pending.ts");
    const cronZero = cron.slice(
      cron.indexOf("if (booking.finalPriceCents === 0)"),
      cron.indexOf("const savedPayment = savedPaymentMethodForBooking"),
    );
    expect(cronZero).toContain("enqueueOwnHostingCoverageReevaluation(");

    const processingMarker = cron.indexOf(
      "status: PaymentStatus.PROCESSING,",
      cron.indexOf("export async function confirmPendingBookings"),
    );
    const processingRelease = cron.slice(
      cron.lastIndexOf("await prisma.$transaction", processingMarker),
      cron.indexOf('"Booking payment processing"', processingMarker),
    );
    const releaseOrder = [
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock(",
      "const lockedBooking = await tx.booking.findUnique(",
      "const released = await tx.booking.updateMany(",
      "reconcileBedAllocationsForBookingWithLodgeLockHeld(",
    ].map((marker) => processingRelease.indexOf(marker));
    expect(releaseOrder.every((index) => index >= 0)).toBe(true);
    expect(releaseOrder).toEqual([...releaseOrder].sort((a, b) => a - b));

    const groupSettlement = readRepoCode("src/lib/group-settlement.ts");
    const groupCommitCalls = [
      ...groupSettlement.matchAll(/await commitChildrenToConfirmed\(/g),
    ];
    expect(groupCommitCalls).toHaveLength(2);
    for (const call of groupCommitCalls) {
      const callerTail = groupSettlement.slice(call.index, call.index + 400);
      expect(callerTail).toContain("settleHostingCoverageAfterCommit({ limit: 25 })");
    }

    const xeroInbound = readRepoCode(
      "src/lib/xero-inbound/invoice-paid-effects.ts",
    );
    const xeroPaid = xeroInbound.slice(
      xeroInbound.indexOf("await acquireLodgeCapacityLock(tx, fresh.booking.lodgeId)"),
      xeroInbound.indexOf(
        "await enqueueOwnHostingCoverageReevaluation(fresh.bookingId",
      ),
    );
    const xeroOrder = [
      "await acquireLodgeCapacityLock(",
      "const locked = await tx.payment.findUnique(",
      "status: locked.booking.status",
      "reconcileBedAllocationsForBookingWithLodgeLockHeld(",
    ].map((marker) => xeroPaid.indexOf(marker));
    expect(xeroOrder.every((index) => index >= 0)).toBe(true);
    expect(xeroOrder).toEqual([...xeroOrder].sort((a, b) => a - b));
  });
});

describe("the participant fence is gated on the hosting policy (#2623 T5)", () => {
  const REVIEW_SERVICE = "src/lib/adult-member-hosting-review.ts";

  function functionStartsIn(service: string): number[] {
    return [...service.matchAll(/\n(?:export )?(?:async )?function \w+/g)].map(
      (match) => match.index ?? 0,
    );
  }

  it("reads the lodge's mode before every queue-participant acquisition", () => {
    // WHY STRUCTURAL. The behavioural proof lives in
    // `adult-member-hosting-same-owner.test.ts`, and it can only assert the sites
    // it happens to reach. This is the claim about the SET: a fourth seam added
    // later, or a gate quietly hoisted out of one of these three, is invisible to
    // every behavioural test that does not already exercise that seam — and the
    // consequence is a `FOR KEY SHARE NOWAIT` taken on an ordinary booking write
    // at a club with the rule switched off, which surfaces to the member as the
    // fixed payment-flavoured retry 409 and nothing else.
    //
    // `await` is part of the pattern so the declaration of
    // `acquireOrValidateQueueParticipantProof` in this same file is not read as a
    // call site.
    const service = readRepoCode(REVIEW_SERVICE);
    const functionStarts = functionStartsIn(service);
    const sites = [
      ...service.matchAll(/await acquireOrValidateQueueParticipantProof\(/g),
    ].map((match) => match.index ?? 0);
    // The three enqueue seams. A change to this number is a new fence: gate it,
    // then say so here.
    expect(sites).toHaveLength(3);

    for (const site of sites) {
      const enclosing = Math.max(
        ...functionStarts.filter((start) => start < site),
        -1,
      );
      const gate = service.lastIndexOf("loadAdultMemberHostingPolicy(", site);
      expect(
        gate,
        `a hosting fence at offset ${site} is acquired before its own function ` +
          "reads the policy mode: " +
          service.slice(site, site + 80).split("\n")[0],
      ).toBeGreaterThan(enclosing);
    }
  });

  it("keeps the un-fenced return fail-fast on the coverage-owner key", () => {
    // THE ONE THING THE GATE GIVES UP, kept bounded. Skipping the fence is safe
    // because an inactive mode reaches no coverage-owner key at all — but the
    // reconciler re-reads the mode for itself one call deeper, so in the narrow
    // window where a lodge turns the rule ON between the two reads, that return
    // IS a path to the coverage-owner advisory lock with no Member fence in
    // front of it. `true` is `failFastCoverageOwner`: it makes that acquisition
    // `pg_try_advisory_xact_lock`, so the worst case is the stable retry 409.
    // Flip it to `false` and the same window becomes a BLOCKING wait taken
    // inside the caller's booking transaction while it holds the global and
    // per-lodge capacity locks — the #2623 T6 hazard relocated, and invisible
    // to every behavioural test because the window needs two interleaved
    // policy reads to open.
    expect(readRepoCode(REVIEW_SERVICE)).toMatch(
      /if \(!hostingModeIsActive\(planned\.mode\)\) \{\s*return reconcileAdultMemberHostingReview\(\s*bookingId,\s*db,\s*options,\s*true,?\s*\);/,
    );
  });

  it("leaves the shared standing-subject barrier deliberately mode-independent", () => {
    // THE OTHER HALF, AND IT IS THE ONE THAT COSTS SOMETHING TO GET WRONG.
    // `lockHostingCoverageMemberLifecycleTarget` looks like a fourth ungated
    // fence and is not one: every standing writer — deactivation, archive,
    // membership cancellation, consent decline, the Xero lapse sync, account
    // deletion — reaches it through this one function, and it is what makes a
    // concurrent booking-request linked-member hold and a deactivation mutually
    // exclusive. `docs/CONCURRENCY_AND_LOCKING.md` states the contract: the
    // hold's refusal "is independent of the lodge's hosting consequence
    // (DISABLED, ADMIN_REVIEW_REQUIRED, or ENFORCED), so review policy is not an
    // identity-safety backstop."
    //
    // A club-wide `ENFORCED` gate was written above it while implementing T5 and
    // real PostgreSQL refuted it: six interleavings in
    // `adult-member-hosting-queue-merge.realdb.test.ts` failed for DISABLED and
    // ADMIN_REVIEW_REQUIRED, because a deletion could then deactivate the member
    // and unlink the guest underneath a hold that had already read them active.
    // So this asserts the ABSENCE of a gate, with the reason, rather than letting
    // the next reader "finish the job".
    const service = readRepoCode(REVIEW_SERVICE);
    const barrier = service.indexOf(
      "await lockHostingCoverageMemberLifecycleTarget(",
    );
    expect(barrier).toBeGreaterThan(-1);
    const enclosing = Math.max(
      ...functionStartsIn(service).filter((start) => start < barrier),
      -1,
    );
    expect(
      service.slice(enclosing, barrier),
      "The standing-subject barrier now has a hosting-policy read above it in " +
        "its own function. That makes identity safety depend on review policy, " +
        "which docs/CONCURRENCY_AND_LOCKING.md forbids by name.",
    ).not.toContain("loadAdultMemberHostingPolicy(");
    // And it is still the FIRST thing that function does, so nothing — not even
    // an empty-fan-out early return — can commit before the subject is frozen.
    expect(
      service.slice(enclosing, barrier),
      "Work moved above the standing-subject barrier.",
    ).not.toContain("loadHostingCoverageMemberFanoutCandidates(");
  });
});

describe("no policy read inside a booking transaction (#2569 §7)", () => {
  it("the create path evaluates the proposed party before the creating service runs", () => {
    // `evaluateProposedAdultMemberHosting` loads the policy rows and the party's
    // member facts. The transaction belongs to `booking-create.ts`, which the three
    // creating branches of this route call; doing the read inside it would hold the
    // per-lodge capacity lock while taking a second pool connection, which is the
    // shape the booking rules forbid outright, and would serialise every concurrent
    // booking at the lodge behind those reads. The refusal also has to come first
    // for a plainer reason: it is the only point where the member can be handed the
    // exception door with the party they actually submitted.
    const source = readRepoCode("src/app/api/bookings/route.ts");
    const evaluation = source.indexOf(
      "await evaluateProposedAdultMemberHosting(prisma, {",
    );
    expect(evaluation).toBeGreaterThan(-1);
    // The ENFORCED refusal sits with it, above every creating call.
    const refusal = source.indexOf(
      'hostingViolation?.consequence === "ENFORCED"',
    );
    expect(refusal).toBeGreaterThan(evaluation);

    const creators = [
      "createDraftBooking({",
      "createConfirmedBooking({",
      "createWaitlistedBooking({",
    ];
    for (const creator of creators) {
      const call = source.indexOf(creator);
      expect(call, creator).toBeGreaterThan(-1);
      expect(refusal, creator).toBeLessThan(call);
    }
    // ...and the transaction really is the service's, not this route's.
    expect(source).not.toContain("prisma.$transaction(");
    expect(readRepoCode("src/lib/booking-create.ts")).toContain(
      "prisma.$transaction(",
    );
  });

  it("the exception-request re-evaluation reads through its own client", () => {
    // The override door: a member refused by a booking path re-submits the party
    // here, and this re-evaluation is what reproduces the violation server-side.
    // It takes the caller's client rather than reaching for the module-level one.
    const source = readRepoFile("src/lib/booking-exception-request-service.ts");
    expect(source).toContain("evaluateProposedAdultMemberHosting(db, {");
  });

  it("every proposed-booking evaluator carries the authoritative Booking.memberId", () => {
    const create = readRepoCode("src/app/api/bookings/route.ts");
    expect(create).toContain("bookingOwnerMemberId: effectiveMemberId");

    const groupJoin = readRepoFile("src/lib/group-booking.ts");
    expect(groupJoin).toContain("bookingOwnerMemberId: sessionUserId");

    const exceptionRequest = readRepoFile(
      "src/lib/booking-exception-request-service.ts",
    );
    expect(exceptionRequest).toContain(
      "bookingOwnerMemberId = await resolveProposalBookingOwner(db, presence)",
    );
    expect(exceptionRequest).toContain("bookingOwnerMemberId,");
  });

  it("the in-transaction reconcilers all pass the transaction client", () => {
    // The composition rule on `loadAdultMemberHostingPolicy`: a caller already
    // inside `prisma.$transaction` MUST pass its own `tx`, or the read checks out
    // a second connection underneath the advisory and capacity locks and sees a
    // different snapshot from the write it is about to decide.
    for (const file of sourceFilesNaming(
      "reconcileAdultMemberHostingReviewWithSiblings(",
    )) {
      if (file === "src/lib/adult-member-hosting-review.ts") continue;
      const source = readRepoFile(file);
      for (const call of source.matchAll(
        /reconcileAdultMemberHostingReviewWithSiblings\(\s*([^)]*)\)/g,
      )) {
        expect(call[1], `${file}: ${call[0]}`).toMatch(/,\s*tx\b/);
      }
    }
  });

  it("keeps the ENFORCED modification bypass exclusive to an approved exception", () => {
    // This option carries a prior attributable officer decision into the real
    // batch service, so it suppresses the ordinary ENFORCED refusal. A route or
    // another service copying it would create an unreviewed bypass even though
    // the implementation still typechecks. Pin both its declaration and its sole
    // supplier tree-wide.
    expect(
      sourceFilesNaming("approvedExceptionAdultMemberHostingDecision"),
    ).toEqual([
      "src/lib/booking-batch-modification-service.ts",
      "src/lib/booking-exception-approval.ts",
    ]);

    expect(readRepoCode("src/lib/booking-batch-modification-service.ts")).toMatch(
      /approvedExceptionAdultMemberHostingDecision\?:\s*\{[\s\S]*?reason:\s*string;[\s\S]*?byMemberId:\s*string;/,
    );
    expect(readRepoCode("src/lib/booking-exception-approval.ts")).toContain(
      "approvedExceptionAdultMemberHostingDecision:",
    );
  });
});

describe("the participant fence stays switched ON where a suite claims it (#2623 F1)", () => {
  /**
   * Suites that wire the #2619 fence doubles but leave the lodge's hosting mode
   * at the resolver's `DISABLED` default, so after #2623 T5's mode gate their
   * seam returns before the fence and the doubles beside it exercise nothing.
   *
   * THIS LIST IS THE POINT. The fence doubles' own docstring names "exercised
   * their seams with the fence effectively switched off" as the state to avoid,
   * and T5 silently put eleven suites into it — silently, because a double that
   * is never reached looks exactly like a double that passes. An exact `toEqual`
   * turns that into an enumerated, reviewable list: a NEW suite that wires the
   * doubles without an active policy fails here, and fixing one means deleting
   * its line.
   *
   * EIGHT OF THE ELEVEN HAVE NOW BEEN FIXED (#2675) and their lines deleted.
   * They were the FIXTURE-DEPTH group: supplying an active mode does not merely
   * re-enable the fence, it runs the hosting EVALUATOR, and their booking
   * fixtures were not hosting-evaluable. Guest rows carried `isMember: true`
   * with no nested `member`, and because `memberIsInGoodStanding` tests
   * `member !== null` — which `undefined` satisfies — the seam did not degrade
   * to "not a member", it read `undefined.active` and threw. The participant's
   * member data comes off the booking fixture's own guest rows, never a
   * `member.findMany` a double could intercept, so the fix was to complete each
   * fixture: `member` (a row via `hostingMemberRow`, or an explicit `null`),
   * `consentStatus`, `nights` and the stay window.
   *
   * MEASURED, TWICE, IN OPPOSITE DIRECTIONS — because "the fixture no longer
   * takes the shortcut" and "the fixture now reaches the fence" are different
   * claims and only the second one is coverage:
   *
   *  - a `throw` in the T5 early return (`adult-member-hosting-review.ts`, the
   *    `!hostingModeIsActive(planned.mode)` branch of
   *    `reconcileAdultMemberHostingReviewWithSiblings`) failed **77 of these
   *    eight suites' 198 tests** before the fixture work — 39 / 11 / 7 / 6 / 5 /
   *    3 / 3 / 3, in the order listed below — and fails **0 of 198** after it;
   *  - a `throw` inside `acquireOrValidateQueueParticipantProof` itself fails
   *    **exactly those same 77**, in exactly that per-suite split. The two
   *    numbers matching is the point: every test that used to skip the fence now
   *    executes it, rather than merely having stopped taking one branch.
   *
   * None of the eight needed an assertion changed. (77, not the 78 an earlier
   * draft of this docstring carried — that figure was never reproduced and the
   * issue's own probe table also says 77.)
   *
   * THE THREE THAT REMAIN ARE BLOCKED BY HOISTING, not by fixtures, and they
   * lose no coverage — measured, no test in them reaches the gate at all. Their
   * policy double lives inside a `vi.mock` factory, which vitest hoists above
   * the imports, so referencing `fenceHostingPolicyFindMany` there is a
   * `ReferenceError: Cannot access '__vi_import_N__' before initialization`.
   * They are recorded here permanently with that reason rather than left to look
   * like unfinished work.
   *
   * A note for whoever fixes the next one: several of the eight ALSO keep a
   * second, hoisted policy double inside their own `vi.mock("@/lib/prisma")`
   * factory, and those were deliberately left alone. They are dead weight —
   * every `reconcileAdultMemberHostingReviewWithSiblings` call site in `src/`
   * passes `tx`, never the singleton — which was confirmed by making one throw
   * and observing the suite stay green.
   */
  const FENCE_DOUBLES_WITHOUT_AN_ACTIVE_POLICY = [
    "src/lib/__tests__/booking-request-quotes.test.ts",
    "src/lib/__tests__/booking-request.test.ts",
    "src/lib/__tests__/school-booking-request.test.ts",
  ];

  it("lists every suite whose fence doubles the mode gate now bypasses", () => {
    const root = path.resolve(process.cwd(), "src");
    const wired: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.test\.tsx?$/.test(entry.name)) continue;
        const rel = path.relative(process.cwd(), full).split(path.sep).join("/");
        // COMMENT-STRIPPED, not raw (#2675 review). This file defines
        // `readRepoCode` precisely because a plain text search reads prose as a
        // call site, and the suites below carry long comments naming both the
        // module and the helper. Reading the raw file let an author delete the
        // wiring, keep the explanation, and stay green.
        const source = readRepoCode(rel);
        if (!source.includes("hosting-participant-fence-double")) continue;
        // The suite that DEFINES the hosting behaviour sets its own policies per
        // test rather than through the shared double, so it is not in scope.
        if (rel === "src/lib/__tests__/adult-member-hosting-review.test.ts") continue;
        // A real CALL, not the identifier appearing somewhere in the file.
        if (/fenceHostingPolicyFindMany\s*\(/.test(source)) continue;
        wired.push(rel);
      }
    };
    walk(root);
    expect(
      wired.sort(),
      "A suite wiring the #2619 fence doubles without an ACTIVE hosting policy " +
        "reaches none of them: T5's mode gate returns first. Either give its tx " +
        "double `fenceHostingPolicyFindMany()` (and make its booking fixtures " +
        "hosting-evaluable), or add it here with a reason.",
    ).toEqual(FENCE_DOUBLES_WITHOUT_AN_ACTIVE_POLICY);
  });

  /**
   * The census above can only see that the helper is CALLED — it cannot see what
   * mode the call states, and #2675 made `{ mode: ... }` an override eight
   * suites now write. Changing one of those words back to an inactive mode
   * restores the exact #2623 T5 bypass with every test in the tree still green,
   * because the gate returns before the fence and the doubles beside it simply
   * stop being reached. Nothing throws; coverage just evaporates.
   *
   * So the value is guarded where it is WRITTEN, and this pins that guard.
   */
  it("refuses to build a policy double in an INACTIVE hosting mode", async () => {
    const { fenceHostingPolicyFindMany } = await import(
      "./support/hosting-participant-fence-double"
    );

    for (const inactive of ["DISABLED", "", "enforced", null, undefined]) {
      expect(
        () =>
          fenceHostingPolicyFindMany({
            mode: inactive as unknown as "ENFORCED",
          }),
        `mode: ${JSON.stringify(inactive)} must be refused`,
      ).toThrow(/ACTIVE hosting mode/);
    }

    // Both ACTIVE modes stay available — the choice between refusing a hazard
    // and recording it is a real one a suite has to make.
    for (const active of ["ENFORCED", "ADMIN_REVIEW_REQUIRED"] as const) {
      const double = fenceHostingPolicyFindMany({ mode: active });
      await expect(double()).resolves.toEqual([
        expect.objectContaining({ mode: active }),
      ]);
    }
    // And the default, which states no mode at all, is still ENFORCED.
    await expect(fenceHostingPolicyFindMany()()).resolves.toEqual([
      expect.objectContaining({ mode: "ENFORCED" }),
    ]);
  });

  /**
   * The mode every wired suite actually states, read off the tree.
   *
   * Belt and braces with the runtime refusal in the helper: that one fires only
   * when a bad mode reaches it AT RUNTIME, so a call site inside a `describe`
   * nobody runs in a focused pass, or one behind a branch, can sit wrong for a
   * while. This reads the literal each suite writes, statically, so the census
   * owns the VALUE as well as the call. (The third route — dropping the helper
   * and hand-rolling a `DISABLED` double under the same key — is what the census
   * above catches: a suite wiring the fence doubles with no
   * `fenceHostingPolicyFindMany(` call is listed there or it fails.)
   */
  it("states an active mode at every fence-policy call site", () => {
    const root = path.resolve(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.test\.tsx?$/.test(entry.name)) continue;
        const rel = path.relative(process.cwd(), full).split(path.sep).join("/");
        // This census file is the guard, not a subject of it: the test above
        // calls the helper deliberately with inactive modes to prove it refuses
        // them, and with a loop variable rather than a literal.
        if (rel === "src/lib/__tests__/adult-member-hosting-call-sites.test.ts") {
          continue;
        }
        const source = readRepoCode(rel);
        for (const match of source.matchAll(
          /fenceHostingPolicyFindMany\s*\(([^)]*)\)/g,
        )) {
          const args = match[1];
          if (!/\bmode\b/.test(args)) continue; // the default is ENFORCED
          if (/"(ENFORCED|ADMIN_REVIEW_REQUIRED)"/.test(args)) continue;
          offenders.push(`${rel}: ${match[0]}`);
        }
      }
    };
    walk(root);
    expect(
      offenders.sort(),
      "A fence policy double naming an INACTIVE mode switches the #2619 " +
        "participant fence off in the suite that wires it (#2623 T5's gate " +
        "returns first) while every test stays green — the #2675 bypass, " +
        "restored by one word. Use ENFORCED or ADMIN_REVIEW_REQUIRED.",
    ).toEqual([]);
  });
});
