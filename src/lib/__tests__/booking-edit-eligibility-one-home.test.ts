import fs from "node:fs";
import path from "node:path";
import { BookingStatus } from "@prisma/client";
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
 * This suite pins the converged rule (`canModifyBookingInActiveLifecycle`) for
 * EVERY role and EVERY `BookingStatus`, so a widening or narrowing is a diff in
 * this file rather than a silent divergence; and it refuses a new hardcoded
 * booking-status eligibility list anywhere near an edit door.
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
 * fifth edit door added next month is in this list the moment its file exists,
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
 * The role strings this predicate is ever handed. `ADMIN` is the only one the
 * policy module tests by name; everything else takes the member branch, and
 * both spellings the tree uses for it are pinned so neither can drift into the
 * admin branch unnoticed.
 */
const ROLES = ["USER", "MEMBER", "ADMIN"] as const;

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
  it("covers every BookingStatus the schema has", () => {
    // The pins below are keyed by name, so a status added to the schema and not
    // added here would simply never be asserted. This is what makes "every
    // status" true rather than merely claimed.
    expect(Object.keys(EXPECTED_EDITABLE).sort()).toEqual([...ALL_STATUSES].sort());
    expect(Object.keys(EXPECTED_EDITABLE_WITH_OVERRIDE).sort()).toEqual(
      [...ALL_STATUSES].sort(),
    );
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
    // not implement.
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

describe("#3245: the refusal sentence has one home, and is generated from the rule", () => {
  const STANDARD =
    "Only PENDING, PAYMENT_PENDING, CONFIRMED, or PAID bookings can be modified";

  it("is word for word what the three copies used to say", () => {
    // Byte-for-byte: this is what makes the convergence behaviour-preserving at
    // the three doors that were restating it.
    expect(activeLifecycleEditRefusal()).toBe(STANDARD);
  });

  it("names the override's wider set when the override is on", () => {
    // The one place the sentence CHANGED (#3245). The date service used to send
    // the standard four here too, on an admin path where COMPLETED had in fact
    // just been admitted — so the refusal named a set that was not the one being
    // applied. Generating it from the options is what makes it true.
    expect(activeLifecycleEditRefusal({ includeFinishedStay: true })).toBe(
      "Only PENDING, PAYMENT_PENDING, CONFIRMED, PAID, or COMPLETED bookings can be modified",
    );
  });

  it("names exactly the statuses the predicate admits, not a list of its own", () => {
    for (const options of [{}, { includeFinishedStay: true }]) {
      const named = activeLifecycleEditRefusal(options).match(/[A-Z][A-Z_]{2,}/g) ?? [];
      expect(
        [...named].sort(),
        `The refusal sentence and the predicate have drifted apart. The ` +
          `sentence is GENERATED from activeLifecycleEditableStatuses for ` +
          `exactly this reason (INV-SSOT-001) — do not type it out.`,
      ).toEqual([...activeLifecycleEditableStatuses("ADMIN", options)].sort());
    }
  });
});

/**
 * The tree the ban is measured over: every route under the bookings API, plus
 * the edit services that sit in `src/lib` outside it. Named files are a risk
 * (`INV-SSOT-004`), which is why the routes are walked and the named list below
 * is kept to modules that a route reaches — the "every door is here" pin at the
 * end of this file is what keeps it honest.
 */
const BOOKINGS_API_TREE = "src/app/api/bookings";
const EDIT_SERVICES = [
  "src/lib/booking-date-modification-service.ts",
  "src/lib/booking-guest-removal-service.ts",
  "src/lib/booking-modify-validation.ts",
  "src/lib/booking-modify.ts",
  "src/lib/booking-batch-modification-service.ts",
];

/** The four doors, and the file that holds each one's eligibility gate. */
const EDIT_DOORS = [
  {
    name: "batch edit (PUT /api/bookings/[id]/modify)",
    gate: "src/lib/booking-modify-validation.ts",
    // The batch edit takes the WIDER base predicate directly: unlike the other
    // three it has an admin lifecycle-skipping path, so DRAFT and the waitlist
    // trio are genuinely editable there. It was already derived before #3245.
    derivation: /canModifyBookingStatusForRole\(booking\.status, role\)/,
  },
  {
    name: "date change (PUT /api/bookings/[id]/modify-dates)",
    gate: "src/lib/booking-date-modification-service.ts",
    derivation: /canModifyBookingInActiveLifecycle\(\s*booking\.status,\s*actor\.role,\s*editOptions,?\s*\)/,
  },
  {
    name: "guest removal (DELETE /api/bookings/[id]/guests/[guestId])",
    gate: "src/lib/booking-guest-removal-service.ts",
    derivation: /canModifyBookingInActiveLifecycle\(booking\.status, actorRole\)/,
  },
  {
    name: "guest add (POST /api/bookings/[id]/guests)",
    gate: "src/app/api/bookings/[id]/guests/route.ts",
    derivation: /canModifyBookingInActiveLifecycle\(booking\.status, actorRole\)/,
  },
] as const;

/**
 * A bracketed literal that enumerates two or more `BookingStatus` values — the
 * shape every one of the three copies had. Matched over comment-stripped
 * source, and deliberately not anchored to `.includes(` or to a variable name:
 * the fourth copy will be spelled differently from the first three, which is
 * how the first three came to look plausible.
 */
const statusListLiterals = (source: string): string[] => {
  const token = new RegExp(
    `(?:"|'|\`|\\bBookingStatus\\.)(${ALL_STATUSES.join("|")})\\b`,
    "g",
  );
  return [...source.matchAll(/\[[^[\]]*\]/g)]
    .filter((match) => {
      const named = new Set(
        [...match[0].matchAll(token)].map((hit) => hit[1]),
      );
      return named.size >= 2;
    })
    .map((match) => match[0].replace(/\s+/g, " "));
};

/**
 * The only files in the population allowed to enumerate booking statuses, each
 * with the reason it is not a second answer to "is this booking still
 * editable?". Adding a line here is a deliberate act with a reason attached;
 * that is the point of an allowlist over a name list.
 *
 * Both entries are the same defect shape one QUESTION over, not one predicate
 * over, which is why #3245 did not convert them: doing so would widen a
 * member-facing door rather than converge one. Both are #3497.
 */
const STATUS_LIST_ALLOWED: Record<string, string> = {
  "src/app/api/bookings/[id]/cancel-preview/route.ts":
    "answers 'can this be CANCELLED?', which is a different and wider set " +
    "(CANCELLABLE_BOOKING_STATUSES in booking-cancel.ts admits the three " +
    "no-money statuses as well). Its list is itself a divergence from that " +
    "one — filed as #3497 — but converging it widens a cancellation path and " +
    "belongs in that issue, not in #3245's behaviour-preserving convergence.",
  "src/app/api/bookings/[id]/notes/route.ts":
    "answers 'may a note be edited on this booking?', a third question again, " +
    "and its set omits PAID. Same shape, same follow-up (#3497).",
  "src/lib/booking-modify-validation.ts":
    "FULLY_PAID_BOOKING_STATUSES answers 'is a ZERO-DOLLAR booking paid up?' " +
    "for the guest-name edit — a money question, not an eligibility one. It " +
    "equals IN_PROGRESS_EDIT_STATUSES today by coincidence, and collapsing it " +
    "onto the edit policy would tie a money test to a rule that can move for " +
    "reasons that have nothing to do with money. It is already named, " +
    "documented and used once, which is one home for its own question. This " +
    "file's EDIT gate is derived, and is pinned by EDIT_DOORS below.",
};

describe("#3245: no edit door states the eligibility rule a second time", () => {
  const population = (): string[] => [
    ...sourceFilesUnder(BOOKINGS_API_TREE),
    ...EDIT_SERVICES,
  ];

  it("the walk really reaches every door, so the ban is not vacuous", () => {
    const files = population();
    for (const door of EDIT_DOORS) {
      expect(files, `${door.name}'s gate dropped out of the census`).toContain(
        door.gate,
      );
    }
    for (const service of EDIT_SERVICES) {
      expect(fs.existsSync(path.join(REPO_ROOT, service)), `${service} is missing`).toBe(
        true,
      );
    }
  });

  it("NO file near an edit door enumerates booking statuses", () => {
    const offenders = population()
      .filter((file) => !(file in STATUS_LIST_ALLOWED))
      .flatMap((file) =>
        statusListLiterals(read(file)).map((literal) => `${file}: ${literal}`),
      );
    expect(
      offenders,
      `These files state a booking-status list of their own. "Is this booking ` +
        `still editable?" has ONE home — canModifyBookingStatusForRole and ` +
        `canModifyBookingInActiveLifecycle in src/lib/booking-edit-policy.ts ` +
        `(INV-SSOT-001). Call one of them. If your door genuinely needs a ` +
        `different set, express it there as a NAMED DERIVATION with its ` +
        `reason, the way canModifyBookingInActiveLifecycle is — do not write ` +
        `a second definition. #3245 removed three of these; #3200's real bug ` +
        `was written by copying one of them. If the list answers a DIFFERENT ` +
        `question, add it to STATUS_LIST_ALLOWED with that reason.`,
    ).toEqual([]);
  });

  it("keeps the allowlist honest", () => {
    // Both directions: the file still exists, and it still needs the exemption
    // it was given. An allowlist entry that no longer matches is a rule quietly
    // relaxed, and #3497 is expected to empty this map.
    const stale = Object.keys(STATUS_LIST_ALLOWED).filter(
      (file) => statusListLiterals(read(file)).length === 0,
    );
    expect(
      stale,
      `These files are exempted from the booking-status-list ban but no ` +
        `longer enumerate one. Delete the entry rather than leaving a ` +
        `standing exemption nothing needs.`,
    ).toEqual([]);
  });

  it("NO file outside the policy module states the refusal sentence", () => {
    // The second half of the duplication: three doors carried the same
    // hand-typed sentence beside their three hand-typed lists. It is generated
    // now, so any occurrence outside the one home is a copy.
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

  for (const door of EDIT_DOORS) {
    it(`${door.name} derives its answer`, () => {
      const source = read(door.gate);
      expect(
        source,
        `${door.gate} no longer reaches the one home. If you moved the gate, ` +
          `move this pin with it; do not delete it.`,
      ).toMatch(door.derivation);
      expect(source).toMatch(
        /from "@\/lib\/booking-edit-policy"/,
      );
    });
  }
});
