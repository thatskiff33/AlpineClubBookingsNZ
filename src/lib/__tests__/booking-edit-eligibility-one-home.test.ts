import fs from "node:fs";
import path from "node:path";
import { BookingStatus, Role } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import {
  activeLifecycleEditRefusal,
  activeLifecycleEditableStatuses,
  canModifyBookingInActiveLifecycle,
  canModifyBookingStatusForRole,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";

/**
 * #3245 (epic #2797): "IS THIS BOOKING STILL EDITABLE AT ALL?" IS ONE QUESTION
 * WITH ONE ANSWER, AT EVERY EDIT DOOR.
 *
 * There are four doors into a booking edit. Until this issue, three of them
 * answered this with the same hardcoded `["PENDING", "PAYMENT_PENDING",
 * "CONFIRMED", "PAID"]` and the same copied refusal sentence, and the fourth
 * derived it from `booking-edit-policy.ts`:
 *
 *  - the batch edit      `PUT  /api/bookings/[id]/modify`      — derived
 *  - the date change     `PUT  /api/bookings/[id]/modify-dates` — was a copy
 *  - the guest removal   `DELETE /api/bookings/[id]/guests/[guestId]` — was a copy
 *  - the guest add       `POST /api/bookings/[id]/guests`       — was a copy
 *
 * The four lists AGREED, so nothing was broken on the day this was filed. That
 * is the whole reason it was worth filing: three copies of an answer are three
 * wrong examples for whoever writes the fifth door, and #3200's real defect was
 * written from exactly one of them. A change to the rule — a club deciding a
 * `COMPLETED` booking may take a late guest — had to be made in four places and
 * would have been made in three.
 *
 * This suite pins the converged rule for EVERY role and EVERY `BookingStatus`,
 * so a widening or narrowing is a diff in this file rather than a silent
 * divergence; and it refuses a new hardcoded booking-status eligibility list
 * anywhere near an edit door.
 *
 * WHAT THIS CENSUS CANNOT SEE, stated because a guard that claims more than it
 * catches is itself the defect (`INV-SSOT-004`). It reads text, so it matches
 * two SHAPES: a bracketed literal naming two or more statuses, and a
 * parenthesised chain of two or more `status === "X"` comparisons. Measured
 * evasions, so this list is what was probed rather than what was assumed: a
 * `switch` with fall-through cases; an object map (`{ PENDING: true }`); a
 * union TYPE; a literal with a nested bracket inside it; a chain that is NOT
 * parenthesised (`const editable = a === "X" || a === "Y";`); and a chain with
 * a call inside it, whose innermost parentheses are the call's. Any door
 * outside the population below is not seen at all. The failure message carries
 * the same list, so whoever trips it knows what the guard is and is not
 * promising.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const read = (relative: string): string => {
  const absolute = path.join(REPO_ROOT, relative);
  // Fail loudly on a moved file rather than passing over an empty string: a
  // census that cannot find its subject is a false green, not a pass (#3200).
  expect(fs.existsSync(absolute), `${relative} is missing`).toBe(true);
  return stripComments(fs.readFileSync(absolute, "utf8"));
};

/**
 * Every non-test source file under a tracked directory, by WALK rather than by
 * name (`INV-SSOT-004`: a population measured by name is not the population). A
 * fifth edit ROUTE added next month is in this list the moment its file exists,
 * which is the only way a census can see the copy it was written to prevent.
 */
const sourceFilesUnder = (relativeRoot: string): string[] => {
  const root = path.join(REPO_ROOT, relativeRoot);
  expect(fs.existsSync(root), `${relativeRoot} is missing`).toBe(true);
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
        continue;
      }
      found.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return found.sort();
};

const ALL_STATUSES: readonly string[] = Object.values(BookingStatus);

/**
 * Every role the schema has, DERIVED rather than listed (`INV-SSOT-004` again).
 * An earlier draft of this file pinned `["USER", "MEMBER", "ADMIN"]`, and
 * `"MEMBER"` is not a `Role` in this tree at all while `LODGE`, `NON_MEMBER` and
 * `SCHOOL` are — so "every role" was three guesses, one of them fictional. The
 * issue's acceptance criterion is every role, and this is what makes that true.
 */
const ROLES: readonly string[] = Object.values(Role);

/** The converged answer, written out once, for every status and every role. */
const EXPECTED_EDITABLE: Record<string, boolean> = {
  DRAFT: false,
  PENDING: true,
  PAYMENT_PENDING: true,
  CONFIRMED: true,
  PAID: true,
  BUMPED: false,
  CANCELLED: false,
  COMPLETED: false,
  WAITLISTED: false,
  WAITLIST_OFFERED: false,
  AWAITING_REVIEW: false,
};

/** The same answer under the #1668 admin date override, which admits a finished stay. */
const EXPECTED_EDITABLE_WITH_OVERRIDE: Record<string, boolean> = {
  ...EXPECTED_EDITABLE,
  COMPLETED: true,
};

describe("#3245: the edit-eligibility answer, pinned per role and per status", () => {
  it("covers every BookingStatus and every Role the schema has", () => {
    // The pins below are keyed by name, so a status added to the schema and not
    // added here would simply never be asserted. This is what makes "every
    // status" true rather than merely claimed — and the same for roles, which
    // an earlier draft of this file got wrong by listing them.
    expect(Object.keys(EXPECTED_EDITABLE).sort()).toEqual([...ALL_STATUSES].sort());
    expect(Object.keys(EXPECTED_EDITABLE_WITH_OVERRIDE).sort()).toEqual(
      [...ALL_STATUSES].sort(),
    );
    expect(ROLES.length, "Role enum reachable and non-empty").toBeGreaterThan(1);
    expect(ROLES).toContain("ADMIN");
  });

  for (const role of ROLES) {
    it(`answers every status the same way for ${role}`, () => {
      const actual = Object.fromEntries(
        ALL_STATUSES.map((status) => [
          status,
          canModifyBookingInActiveLifecycle(status, role),
        ]),
      );
      expect(
        actual,
        `The set of statuses an edit door admits has CHANGED for ${role}. ` +
          `This is a real widening or narrowing of who may edit a booking, ` +
          `not a refactor: update the pin deliberately, with the issue that ` +
          `decided it, or undo the change.`,
      ).toEqual(EXPECTED_EDITABLE);
    });

    it(`answers every status the same way for ${role} under the admin date override`, () => {
      const actual = Object.fromEntries(
        ALL_STATUSES.map((status) => [
          status,
          canModifyBookingInActiveLifecycle(status, role, {
            includeFinishedStay: true,
          }),
        ]),
      );
      expect(actual).toEqual(EXPECTED_EDITABLE_WITH_OVERRIDE);
    });
  }

  it("is the intersection it claims to be, and takes nothing from anywhere else", () => {
    // The docblock on `canModifyBookingInActiveLifecycle` says it is
    // `canModifyBookingStatusForRole` INTERSECTED with
    // `usesActiveBookingEditLifecycle`, minus the finished stay. A docblock
    // claim is a contract; this is the test of it, so the derivation cannot
    // quietly grow a status of its own.
    for (const role of ROLES) {
      for (const status of ALL_STATUSES) {
        const intersection =
          canModifyBookingStatusForRole(status, role) &&
          usesActiveBookingEditLifecycle(status);
        expect(
          canModifyBookingInActiveLifecycle(status, role, {
            includeFinishedStay: true,
          }),
          `${role}/${status} under the override is the plain intersection`,
        ).toBe(intersection);
        expect(
          canModifyBookingInActiveLifecycle(status, role),
          `${role}/${status} without the override is that, minus COMPLETED`,
        ).toBe(intersection && status !== BookingStatus.COMPLETED);
      }
    }
  });

  it("the admin date override adds the finished stay and NOTHING else", () => {
    for (const role of ROLES) {
      const widened = ALL_STATUSES.filter(
        (status) =>
          canModifyBookingInActiveLifecycle(status, role, {
            includeFinishedStay: true,
          }) && !canModifyBookingInActiveLifecycle(status, role),
      );
      expect(
        widened,
        `The #1668 admin date override exists to reach a FULLY-PAST booking. ` +
          `It has started admitting something else as well.`,
      ).toEqual([BookingStatus.COMPLETED]);
    }
  });

  it("the role moves no status into or out of this set today", () => {
    // Not a tautology and not an accident: `DRAFT` (member, #2266) and the
    // waitlist trio (admin) are the statuses `canModifyBookingStatusForRole`
    // moves by role, and all four sit OUTSIDE the active-lifecycle set, so the
    // intersection collapses to the same four either way. The refusal sentence
    // takes no role because of this. If this ever fails, the sentence needs a
    // role before anything else does.
    const perRole = ROLES.map((role) => activeLifecycleEditableStatuses(role));
    for (const statuses of perRole) {
      expect(statuses).toEqual(perRole[0]);
    }
    expect(perRole[0]).toEqual([
      BookingStatus.PENDING,
      BookingStatus.PAYMENT_PENDING,
      BookingStatus.CONFIRMED,
      BookingStatus.PAID,
    ]);
  });

  it("a booking-request hold and a draft are still refused at every edit door", () => {
    // The two statuses other invariants lean on this refusing. `AWAITING_REVIEW`
    // is INV-MOD-047's reason the approval preservation path can never meet a
    // blank; `DRAFT` is #2266's lifecycle-inert edit, which these three doors do
    // not implement. #3245 deleted a dead `MEMBER_MODIFIABLE_BOOKING_STATUSES`
    // that disagreed with the first of these.
    for (const role of ROLES) {
      for (const status of [BookingStatus.AWAITING_REVIEW, BookingStatus.DRAFT]) {
        expect(canModifyBookingInActiveLifecycle(status, role)).toBe(false);
        expect(
          canModifyBookingInActiveLifecycle(status, role, {
            includeFinishedStay: true,
          }),
        ).toBe(false);
      }
    }
  });
});

describe("#3245: the refusal has one home, and one call", () => {
  const STANDARD =
    "Only PENDING, PAYMENT_PENDING, CONFIRMED, or PAID bookings can be modified";
  const REFUSED = BookingStatus.CANCELLED;

  it("is null when the booking IS editable, so a door cannot refuse a legal edit", () => {
    for (const role of ROLES) {
      expect(activeLifecycleEditRefusal(BookingStatus.PAID, role)).toBeNull();
      expect(
        activeLifecycleEditRefusal(BookingStatus.COMPLETED, role, {
          includeFinishedStay: true,
        }),
      ).toBeNull();
    }
  });

  it("is word for word what the three copies used to say", () => {
    // Byte-for-byte: this is what makes the convergence behaviour-preserving at
    // the three doors that were restating it.
    expect(activeLifecycleEditRefusal(REFUSED, "ADMIN")).toBe(STANDARD);
  });

  it("names the override's wider set when the override is on", () => {
    // The one place the sentence CHANGED (#3245). The date service used to send
    // the standard four here too, on an admin path where COMPLETED had in fact
    // just been admitted — so the refusal named a set that was not the one being
    // applied. Deriving it from the same call is what makes it true.
    expect(
      activeLifecycleEditRefusal(REFUSED, "ADMIN", { includeFinishedStay: true }),
    ).toBe(
      "Only PENDING, PAYMENT_PENDING, CONFIRMED, PAID, or COMPLETED bookings can be modified",
    );
  });

  it("names exactly the statuses the predicate admits, not a list of its own", () => {
    for (const options of [{}, { includeFinishedStay: true }]) {
      const admitted = activeLifecycleEditableStatuses("ADMIN", options);
      // Non-vacuity: an empty set would make the sentence "Only no bookings can
      // be modified", whose status tokens are `[]` — and `[]` equals `[]`. The
      // assertion below would then pass while saying nothing at all.
      expect(admitted.length, "the editable set is not empty").toBeGreaterThan(0);
      const named = activeLifecycleEditRefusal(REFUSED, "ADMIN", options)?.match(
        /[A-Z][A-Z_]{2,}/g,
      );
      expect(
        [...(named ?? [])].sort(),
        `The refusal sentence and the predicate have drifted apart. The ` +
          `sentence is GENERATED from activeLifecycleEditableStatuses for ` +
          `exactly this reason (INV-SSOT-001) — do not type it out.`,
      ).toEqual([...admitted].sort());
    }
  });
});

/**
 * The tree the ban is measured over. Three parts, and the second exists because
 * the first cannot reach a door that lives in `src/lib` — which is the shape all
 * four current doors have:
 *
 *  1. every route under the bookings API, WALKED;
 *  2. every `src/lib` file that imports the edit-policy module, MEASURED — so a
 *     new service asking this question through the one home is in the census the
 *     moment it exists, rather than when somebody remembers to list it;
 *  3. the named edit modules, as a floor. A brand-new service that hardcodes a
 *     list WITHOUT importing the policy module is in none of the three, and that
 *     is the census's stated blind spot rather than a claim it quietly fails.
 *
 * Walking the whole of `src/lib` was measured and rejected: 53 status literals
 * across cron sweeps, waitlist, Xero, payment reconciliation and diagnostics,
 * nearly all of them different questions. That allowlist would be the rule.
 */
const BOOKINGS_API_TREE = "src/app/api/bookings";
const NAMED_EDIT_MODULES = [
  "src/lib/booking-date-modification-service.ts",
  "src/lib/booking-guest-removal-service.ts",
  "src/lib/booking-modify-validation.ts",
  "src/lib/booking-modify.ts",
  "src/lib/booking-batch-modification-service.ts",
  // Holds the self-removal eligibility set the guest-removal door's other
  // branch reads, so the same door has two eligibility answers; both are in
  // the census.
  "src/lib/booking-guest-self-removal.ts",
];
const EDIT_POLICY_MODULE = "src/lib/booking-edit-policy.ts";

const policyImporters = (): string[] =>
  sourceFilesUnder("src/lib").filter(
    (file) =>
      file !== EDIT_POLICY_MODULE &&
      /from "@\/lib\/booking-edit-policy"/.test(
        fs.readFileSync(path.join(REPO_ROOT, file), "utf8"),
      ),
  );

const population = (): string[] =>
  [
    ...new Set([
      ...sourceFilesUnder(BOOKINGS_API_TREE),
      ...policyImporters(),
      ...NAMED_EDIT_MODULES,
    ]),
  ].sort();

/**
 * The five server-side gates that decide whether a booking may be edited, and
 * the derivation each reaches. Four are the doors above; `adminShiftBookingDates`
 * is the fifth gate in the same family (#1668's price-frozen date move), which
 * takes the WIDER base predicate directly.
 *
 * The regexes are whitespace-tolerant on purpose: an earlier draft pinned the
 * exact single-line spelling, so re-wrapping a call — which Prettier does the
 * moment a line grows — failed with "no longer reaches the one home", which
 * would have been untrue.
 *
 * `actedOn` is the second half, and it exists because the FIRST half stopped
 * being enough when the refusal moved to a `string | null` return. The pin it
 * replaced matched `!canModifyBookingInActiveLifecycle(...)` — a negated
 * boolean, nearly unwritable except as a condition. The shape now spans two
 * statements, so matching only the call would let a later edit weaken the
 * throw — `if (editRefusal && !someOverride)`, or moving it behind a branch —
 * while every guard in this file stayed green. #3244 is stacked on one of these
 * very doors, so that is a live hazard rather than a hypothetical one.
 */
const EDIT_GATES = [
  {
    name: "batch edit (PUT /api/bookings/[id]/modify)",
    gate: "src/lib/booking-modify-validation.ts",
    // Takes the WIDER base predicate: unlike the other three doors it has an
    // admin lifecycle-skipping path, so DRAFT and the waitlist trio are
    // genuinely editable there. Already derived before #3245.
    derivation: /canModifyBookingStatusForRole\(\s*booking\.status,\s*role,?\s*\)/,
    actedOn:
      /if \(!canModifyBookingStatusForRole\([^)]*\)\)\s*\{\s*throw new ApiError\(/,
  },
  {
    name: "admin shift-dates override (adminShiftBookingDates)",
    gate: "src/lib/booking-date-modification-service.ts",
    derivation: /canModifyBookingStatusForRole\(\s*booking\.status,\s*"ADMIN",?\s*\)/,
    actedOn:
      /if \(!canModifyBookingStatusForRole\([^)]*\)\)\s*\{\s*throw new ApiError\(/,
  },
  {
    name: "date change (PUT /api/bookings/[id]/modify-dates)",
    gate: "src/lib/booking-date-modification-service.ts",
    derivation:
      /activeLifecycleEditRefusal\(\s*booking\.status,\s*actor\.role,\s*\{\s*includeFinishedStay:\s*adminOverride,?\s*\},?\s*\)/,
    actedOn: /if \(editRefusal\) throw new ApiError\(\s*editRefusal,\s*400,?\s*\)/,
  },
  {
    name: "guest removal (DELETE /api/bookings/[id]/guests/[guestId])",
    gate: "src/lib/booking-guest-removal-service.ts",
    derivation: /activeLifecycleEditRefusal\(\s*booking\.status,\s*actorRole,?\s*\)/,
    actedOn:
      /if \(editRefusal\) throw new BookingGuestRemovalError\(\s*editRefusal,\s*400,?\s*\)/,
  },
  {
    name: "guest add (POST /api/bookings/[id]/guests)",
    gate: "src/app/api/bookings/[id]/guests/route.ts",
    derivation: /activeLifecycleEditRefusal\(\s*booking\.status,\s*actorRole,?\s*\)/,
    actedOn: /if \(editRefusal\) throw new ApiError\(\s*editRefusal,\s*400,?\s*\)/,
  },
] as const;

const STATUS_TOKEN = `(?:"|'|\`|\\bBookingStatus\\.)(${ALL_STATUSES.join("|")})\\b`;
// Anchored so `assignment.status` (a bed allocation) is not read as a booking
// status: either the `booking.status` / `bookingStatus` spellings, or a bare
// `status` identifier that is not a property of something else.
const STATUS_COMPARISON = `(?:booking\\.status|bookingStatus|(?<![.\\w])status)\\s*(?:===|!==)\\s*${STATUS_TOKEN}`;

const distinctStatuses = (fragment: string, source: string): Set<string> =>
  new Set([...fragment.matchAll(new RegExp(source, "g"))].map((hit) => hit[1] ?? ""));

/**
 * The two shapes a hardcoded eligibility set takes here: a bracketed literal
 * naming two or more statuses, and a parenthesised chain of two or more
 * `status === "X"` comparisons. The second was added after review pointed out
 * that the copy most likely to be written fresh is the chain, and that one is
 * live in the population today (the guest-add route's hold window) — so the
 * shape demonstrably goes unseen unless it is matched.
 */
const statusSetExpressions = (source: string): string[] => [
  ...[...source.matchAll(/\[[^[\]]*\]/g)]
    .filter((match) => distinctStatuses(match[0], STATUS_TOKEN).size >= 2)
    .map((match) => match[0].replace(/\s+/g, " ")),
  ...[...source.matchAll(/\([^()]*\)/g)]
    .filter((match) => distinctStatuses(match[0], STATUS_COMPARISON).size >= 2)
    .map((match) => match[0].replace(/\s+/g, " ")),
];

/**
 * The status sets in the population that are NOT a second answer to "is this
 * booking still editable?", each keyed to the EXACT expression permitted and the
 * reason it is permitted.
 *
 * Exact expressions rather than whole files, because a whole-file exemption
 * switches the ban off in that file — and one of the files below is a DOOR'S OWN
 * GATE, so a second hardcoded list added beside the derived one would have been
 * invisible. A new set in an exempted file now trips the census like any other.
 */
const PERMITTED_STATUS_SETS: Record<string, { reason: string; expressions: string[] }> = {
  "src/app/api/bookings/[id]/cancel-preview/route.ts": {
    reason:
      "answers 'can this be CANCELLED?', a different and wider question " +
      "(CANCELLABLE_BOOKING_STATUSES in booking-cancel.ts admits three more). " +
      "Its list is itself a divergence from that one — filed as #3497 — but " +
      "converging it widens a member-facing cancellation path and belongs in " +
      "that issue, not in #3245's behaviour-preserving convergence.",
    expressions: ['["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID"]'],
  },
  "src/app/api/bookings/[id]/notes/route.ts": {
    reason:
      "answers 'may a note be edited on this booking?', a third question " +
      "again, and its set omits PAID. Same shape, same follow-up (#3497).",
    expressions: ['["PAYMENT_PENDING", "CONFIRMED", "PENDING"]'],
  },
  "src/app/api/bookings/[id]/arrival-time/route.ts": {
    reason:
      "answers 'may an arrival time still be set?' as a NEGATIVE pair — a " +
      "finished or cancelled stay — which is neither the edit set nor a " +
      "subset of it.",
    expressions: [
      '(booking.status === "CANCELLED" || booking.status === "COMPLETED")',
      '(booking.status === "CANCELLED" || booking.status === "COMPLETED")',
    ],
  },
  "src/app/api/bookings/[id]/guests/route.ts": {
    reason:
      "the HOLD WINDOW, not eligibility: whether an unpaid booking is still " +
      "inside its hold and may be released to PAYMENT_PENDING. It runs long " +
      "after the eligibility gate has admitted the booking.",
    expressions: [
      '(booking.status === "PENDING" || booking.status === "PAYMENT_PENDING")',
    ],
  },
  "src/lib/booking-modify-validation.ts": {
    reason:
      "FULLY_PAID_BOOKING_STATUSES answers 'is a ZERO-DOLLAR booking paid " +
      "up?' for the guest-name edit — a money question. It equals " +
      "IN_PROGRESS_EDIT_STATUSES today by coincidence, and collapsing it onto " +
      "the edit policy would tie a money test to a rule that can move for " +
      "reasons that have nothing to do with money.",
    expressions: ["[ BookingStatus.PAID, BookingStatus.COMPLETED, ]"],
  },
  "src/lib/booking-guest-self-removal.ts": {
    reason:
      "SELF_REMOVABLE_GUEST_BOOKING_STATUSES answers 'may a guest take " +
      "THEMSELVES off?', which is deliberately wider — it admits DRAFT. It is " +
      "already one home for its own question, read by the removal service and " +
      "the consent card.",
    expressions: [
      "[ BookingStatus.DRAFT, BookingStatus.PENDING, BookingStatus.PAYMENT_PENDING, BookingStatus.CONFIRMED, BookingStatus.PAID, BookingStatus.WAITLISTED, BookingStatus.WAITLIST_OFFERED, BookingStatus.AWAITING_REVIEW, ]",
    ],
  },
  "src/lib/booking-cancel.ts": {
    reason:
      "the cancellation sets — the one home for 'can this be cancelled?' and " +
      "its no-money subset. A different question from editing; #3497 is the " +
      "issue for giving IT one home across its own three doors.",
    expressions: [
      '[ "PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID", "WAITLISTED", "WAITLIST_OFFERED", "AWAITING_REVIEW", ]',
      '[ "WAITLISTED", "WAITLIST_OFFERED", "AWAITING_REVIEW", ]',
      '["PAYMENT_PENDING", "CONFIRMED", "PAID"]',
      "[ BookingStatus.PAYMENT_PENDING, BookingStatus.CONFIRMED, BookingStatus.PAID, ]",
    ],
  },
  "src/lib/diagnostics/tools/packs/booking-evidence.ts": {
    reason:
      "a read-only diagnostics pack. These are display filters over booking " +
      "history — which bookings to show as dropped, which as waitlisted — and " +
      "gate no edit.",
    expressions: ['["CANCELLED", "BUMPED"]', '[ "WAITLISTED", "WAITLIST_OFFERED", ]'],
  },
};

describe("#3245: no edit door states the eligibility rule a second time", () => {
  it("the population really reaches every gate, so the ban is not vacuous", () => {
    const files = population();
    for (const gate of EDIT_GATES) {
      expect(files, `${gate.name}'s gate dropped out of the census`).toContain(
        gate.gate,
      );
    }
    // The measured half is doing work rather than being subsumed by the names:
    // if every policy importer were already a named module, the "measured"
    // claim in the docblock above would be decoration.
    expect(
      policyImporters().some((file) => !NAMED_EDIT_MODULES.includes(file)),
      "the measured half of the population adds files the names do not",
    ).toBe(true);
  });

  it("NO file near an edit door states a booking-status set of its own", () => {
    const offenders = population().flatMap((file) => {
      const permitted = [...(PERMITTED_STATUS_SETS[file]?.expressions ?? [])];
      return statusSetExpressions(read(file))
        .filter((found) => {
          const at = permitted.indexOf(found);
          if (at === -1) return true;
          // Consume it, so a file permitted ONE copy of an expression cannot
          // quietly grow a second.
          permitted.splice(at, 1);
          return false;
        })
        .map((found) => `${file}: ${found}`);
    });
    expect(
      offenders,
      `These files state a booking-status set of their own. "Is this booking ` +
        `still editable?" has ONE home — canModifyBookingStatusForRole and ` +
        `canModifyBookingInActiveLifecycle in src/lib/booking-edit-policy.ts ` +
        `(INV-SSOT-001), with activeLifecycleEditRefusal for the sentence. ` +
        `Call one of them. If your door genuinely needs a different set, ` +
        `express it THERE as a named derivation with its reason — do not ` +
        `write a second definition. #3245 removed three of these plus a dead ` +
        `fifth; #3200's real bug was written by copying one. If the set ` +
        `answers a DIFFERENT question, add the exact expression to ` +
        `PERMITTED_STATUS_SETS with that reason.\n` +
        `NOTE this census matches two shapes only — a bracketed literal, and ` +
        `a parenthesised chain of === comparisons. NOT caught, measured: a ` +
        `switch, an object map, a union type, a literal with a nested ` +
        `bracket, an unparenthesised chain, and a chain with a call inside ` +
        `it. A door outside the population is not seen at all. Passing this ` +
        `is not proof there is no copy.`,
    ).toEqual([]);
  });

  it("keeps the permitted list honest", () => {
    // Both directions: every permitted expression is still present, and the
    // file still exists. A permission that no longer matches is a rule quietly
    // relaxed, and #3497 is expected to empty several of these.
    const stale: string[] = [];
    for (const [file, { expressions }] of Object.entries(PERMITTED_STATUS_SETS)) {
      const found = statusSetExpressions(read(file));
      for (const expression of expressions) {
        const at = found.indexOf(expression);
        if (at === -1) stale.push(`${file}: ${expression}`);
        else found.splice(at, 1);
      }
    }
    expect(
      stale,
      `These expressions are permitted but no longer appear. Delete the entry ` +
        `rather than leaving a standing exemption nothing needs — an exemption ` +
        `kept past its subject is how a later copy gets waved through.`,
    ).toEqual([]);
  });

  it("the lifecycle-status module grows no second answer to THIS question", () => {
    // Targeted rather than general, and the reason is measured: #3245 deleted
    // `MEMBER_MODIFIABLE_BOOKING_STATUSES` from `booking-status.ts` — a dead,
    // canonically-named, test-blessed set that admitted AWAITING_REVIEW and so
    // disagreed with every edit door. That module is THE home for booking-status
    // sets and holds a dozen legitimate ones, so putting it in the ban above
    // would tax every unrelated set added there for ever. What must not come
    // back is a set NAMED for this question, which is what made the deleted one
    // the most findable wrong example in the tree.
    const names =
      read("src/lib/booking-status.ts").match(
        /export const ([A-Z0-9_]*(?:MODIFIABLE|EDITABLE)[A-Z0-9_]*)/g,
      ) ?? [];
    expect(
      names,
      `src/lib/booking-status.ts has grown a set named for "which bookings ` +
        `may be modified/edited". That question is answered by ` +
        `canModifyBookingInActiveLifecycle in src/lib/booking-edit-policy.ts ` +
        `(INV-SSOT-001). #3245 deleted exactly such a set from this module: it ` +
        `had no production reader and it was WRONG, and its name is what made ` +
        `it the example somebody would have copied.`,
    ).toEqual([]);
  });

  it("NO file outside the policy module states the refusal sentence", () => {
    // The second half of the duplication: three doors carried the same
    // hand-typed sentence beside their three hand-typed lists. It is generated
    // now, so any occurrence outside the one home is a copy. Wording-anchored,
    // so a re-typed "may be modified" would evade — the shape above is the
    // guard that matters; this one catches the literal paste.
    const offenders = population().filter((file) =>
      /bookings can be modified/.test(read(file)),
    );
    expect(
      offenders,
      `These files spell out the edit refusal. It is GENERATED from the rule ` +
        `by activeLifecycleEditRefusal in src/lib/booking-edit-policy.ts ` +
        `(INV-SSOT-001) so that a change to the rule cannot leave a door ` +
        `telling a member something untrue — call it instead.`,
    ).toEqual([]);
  });

  it("the refusal sentence cannot be built without the status it is about", () => {
    // The structural half of the fix, and the reason the sentence builder is
    // not exported: a door that asked the predicate with
    // `{ includeFinishedStay: true }` and then printed a sentence built
    // WITHOUT it would reproduce exactly the bug #3245 fixed, and every other
    // check in this file would stay green. One call, or nothing.
    const policy = read(EDIT_POLICY_MODULE);
    expect(policy).toMatch(
      /export function activeLifecycleEditRefusal\(\s*status: string,\s*role: string,/,
    );
    expect(
      policy,
      `activeLifecycleEditRefusalText is the sentence WITHOUT the status. ` +
        `Exporting it lets a caller state the options twice and get two ` +
        `different answers (INV-SSOT-002). All three spellings are refused — ` +
        `a function, a const arrow, and a trailing export statement — because ` +
        `an earlier draft pinned only the first and the other two evaded it.`,
    ).not.toMatch(
      /export\s+(?:function|const)\s+activeLifecycleEditRefusalText|export\s*\{[^}]*\bactiveLifecycleEditRefusalText\b/,
    );
  });

  for (const gate of EDIT_GATES) {
    it(`${gate.name} derives its answer`, () => {
      const source = read(gate.gate);
      expect(
        source,
        `${gate.gate} no longer reaches the one home. If you moved the gate, ` +
          `move this pin with it; do not delete it.`,
      ).toMatch(gate.derivation);
      expect(
        source,
        `${gate.gate} reaches the one home but no longer ACTS on its answer ` +
          `unconditionally. Asking the rule and then not refusing on it is ` +
          `the same defect as not asking: the refusal must throw whenever it ` +
          `is non-null, with no extra condition in front of it.`,
      ).toMatch(gate.actedOn);
      expect(source).toMatch(/from "@\/lib\/booking-edit-policy"/);
    });
  }
});
