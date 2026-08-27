// "+ Add Member Guest" (epic #2305) MG1 (#2306) — the consent sub-state model.
//
// Five nullable columns are thirty-two shapes on paper. Only eight are legal,
// and which one a row is in decides real things: whether a bed is held, whether
// anyone was ever asked, and who the club can point at if the answer is
// questioned later. This file pins that table so MG2/MG3/MG4 each add a writer
// against a fixed contract instead of re-deriving one.
//
// It also pins the two discriminations that are easy to lose and expensive to
// lose:
//   * NULL is not CONFIRMED. "Nobody had to be asked" is a different fact from
//     "somebody said yes", and once they are conflated no later code can undo
//     it.
//   * A consent that was never SOLICITED (notify-only, or an admin placing the
//     guest) is not the same as one the target granted. requestedAt is the
//     discriminator, and respondedByMemberId separates the two unsolicited
//     cases from each other.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { MemberGuestConsentStatus } from "@prisma/client";

import {
  CONSENT_FREE_GUEST_COLUMNS,
  MEMBER_GUEST_CONSENT_MIN_HOLD_MS,
  MEMBER_GUEST_CONSENT_SUB_STATES,
  OPERATIONALLY_PRESENT_GUEST_WHERE,
  buildMemberGuestConsentWrite,
  classifyMemberGuestConsent,
  computeMemberGuestConsentExpiry,
  isOperationallyPresentConsent,
  type MemberGuestAddActor,
  type MemberGuestBoundaryScope,
  type MemberGuestConsentColumns,
} from "@/lib/member-guest-consent";
import { normalizeMemberGuestSettings } from "@/lib/member-guest-settings";
import {
  DEFAULT_MEMBER_GUEST_SETTINGS,
  MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX,
  MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN,
} from "@/config/club-settings-defaults";
import {
  clubCalendarDateOf,
  dateOnlyInstantOf,
  requireCalendarDate,
  requireClubTimeZone,
  startOfClubDay,
} from "@/lib/club-time";

// Test helper: reads a fixed repo file under process.cwd(); the path is
// test-controlled, not user input.
function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

const TARGET = "m-target";
const DELEGATE = "m-delegate";
const ADMIN = "m-admin";
const T = new Date("2026-07-31T00:00:00.000Z");

function row(overrides: Partial<MemberGuestConsentColumns> = {}): MemberGuestConsentColumns {
  return { ...CONSENT_FREE_GUEST_COLUMNS, ...overrides };
}

describe("consent sub-state table", () => {
  it("declares exactly the eight reachable shapes, with unique ids", () => {
    const ids = MEMBER_GUEST_CONSENT_SUB_STATES.map((s) => s.id);
    expect(ids).toEqual([
      "FAMILY_OR_LEGACY",
      "AWAITING_TARGET",
      "TARGET_APPROVED",
      "DELEGATE_APPROVED",
      "NOTIFY_ONLY_AUTO_CONFIRMED",
      "ADMIN_ASSIGNED",
      "DECLINED",
      "EXPIRED",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("records which shapes predate the feature going live", () => {
    // MG1's version of this case asserted the dark guarantee as data: exactly one
    // shape reachable, and MEMBER_GUEST_WIDENING_ENABLED false. MG2 (#2307)
    // deliberately breaks both halves, so what is pinned now is the historical
    // fact the field actually records — only the consent-FREE shape existed
    // before the widening, and every other shape arrived with it.
    const byRelease = (release: string) =>
      MEMBER_GUEST_CONSENT_SUB_STATES.filter((s) => s.firstReachableIn === release).map(
        (s) => s.id,
      );

    expect(byRelease("MG1")).toEqual(["FAMILY_OR_LEGACY"]);
    expect(byRelease("MG2")).toEqual([
      "AWAITING_TARGET",
      "TARGET_APPROVED",
      "DELEGATE_APPROVED",
      "NOTIFY_ONLY_AUTO_CONFIRMED",
      "ADMIN_ASSIGNED",
      "DECLINED",
      "EXPIRED",
    ]);
  });

  it("gives every shape a written note", () => {
    for (const state of MEMBER_GUEST_CONSENT_SUB_STATES) {
      expect(state.note.length).toBeGreaterThan(20);
    }
  });

  it("keeps the two never-solicited shapes distinguishable", () => {
    // The amendment that made this table binding turns on exactly this pair.
    const notifyOnly = MEMBER_GUEST_CONSENT_SUB_STATES.find(
      (s) => s.id === "NOTIFY_ONLY_AUTO_CONFIRMED",
    )!;
    const adminAssigned = MEMBER_GUEST_CONSENT_SUB_STATES.find(
      (s) => s.id === "ADMIN_ASSIGNED",
    )!;

    // Both are CONFIRMED with no request...
    expect(notifyOnly.status).toBe("CONFIRMED");
    expect(adminAssigned.status).toBe("CONFIRMED");
    expect(notifyOnly.requestedAt).toBe("null");
    expect(adminAssigned.requestedAt).toBe("null");

    // ...and the responder is what tells them apart. Auto-confirm has nobody to
    // name; an admin assignment names the admin, which is how MG4's audit works
    // without a new column.
    expect(notifyOnly.respondedAt).toBe("null");
    expect(notifyOnly.respondedBy).toBe("null");
    expect(adminAssigned.respondedAt).toBe("set");
    expect(adminAssigned.respondedBy).toBe("admin");

    // Neither is waiting for an answer, so neither carries a hold deadline.
    // The classifier enforces this; without it, "CONFIRMED with an expiry"
    // would classify happily and MG2's sweep would meet a settled row that
    // looks like a live hold.
    expect(notifyOnly.expiresAt).toBe("null");
    expect(adminAssigned.expiresAt).toBe("null");
  });

  it("requires a decline to name who refused", () => {
    // Declining is an attributed act: MG4's audit reads respondedBy to say who
    // turned the add down, so "any" would let an unattributed refusal through.
    const declined = MEMBER_GUEST_CONSENT_SUB_STATES.find((s) => s.id === "DECLINED")!;
    expect(declined.respondedBy).toBe("set");
  });
});

describe("classifyMemberGuestConsent", () => {
  it("classifies a family-scope or legacy row", () => {
    expect(classifyMemberGuestConsent(row(), TARGET)).toBe("FAMILY_OR_LEGACY");
    expect(classifyMemberGuestConsent(row(), null)).toBe("FAMILY_OR_LEGACY");
  });

  it("classifies a pending hold", () => {
    expect(
      classifyMemberGuestConsent(
        row({ consentStatus: "PENDING", consentRequestedAt: T, consentExpiresAt: T }),
        TARGET,
      ),
    ).toBe("AWAITING_TARGET");
  });

  it("separates a target approval from a delegate approval by the responder", () => {
    const base = {
      consentStatus: "CONFIRMED" as const,
      consentRequestedAt: T,
      consentRespondedAt: T,
    };
    expect(
      classifyMemberGuestConsent(row({ ...base, consentRespondedByMemberId: TARGET }), TARGET),
    ).toBe("TARGET_APPROVED");
    expect(
      classifyMemberGuestConsent(row({ ...base, consentRespondedByMemberId: DELEGATE }), TARGET),
    ).toBe("DELEGATE_APPROVED");
  });

  it("classifies a notify-only auto-confirm", () => {
    // CONFIRMED with nothing else set. This is the shape the coherence review
    // made binding, and it is deliberately NOT written as all-nulls: the guest
    // IS cross-family, and that has to stay visible.
    const auto = row({ consentStatus: "CONFIRMED" });
    expect(classifyMemberGuestConsent(auto, TARGET)).toBe("NOTIFY_ONLY_AUTO_CONFIRMED");
    expect(classifyMemberGuestConsent(auto, TARGET)).not.toBe("FAMILY_OR_LEGACY");
  });

  it("classifies an admin-assigned or copied row", () => {
    expect(
      classifyMemberGuestConsent(
        row({
          consentStatus: "CONFIRMED",
          consentRespondedAt: T,
          consentRespondedByMemberId: ADMIN,
        }),
        TARGET,
      ),
    ).toBe("ADMIN_ASSIGNED");
  });

  it("classifies a decline and an expiry, and keeps them apart", () => {
    expect(
      classifyMemberGuestConsent(
        row({
          consentStatus: "DECLINED",
          consentRequestedAt: T,
          consentRespondedAt: T,
          consentRespondedByMemberId: TARGET,
        }),
        TARGET,
      ),
    ).toBe("DECLINED");

    // Nobody refused; the clock ran out. No responder, by definition.
    expect(
      classifyMemberGuestConsent(
        row({ consentStatus: "EXPIRED", consentRequestedAt: T, consentExpiresAt: T }),
        TARGET,
      ),
    ).toBe("EXPIRED");
  });

  it("refuses to classify combinations the model does not define", () => {
    // The useful failure. A writer that invents a shape gets null here rather
    // than being quietly filed under the nearest legal one.
    const illegal: Array<[string, MemberGuestConsentColumns]> = [
      ["null status carrying a request", row({ consentRequestedAt: T })],
      ["null status carrying a responder", row({ consentRespondedByMemberId: ADMIN })],
      ["pending with no expiry (an unbounded bed hold)", row({ consentStatus: "PENDING", consentRequestedAt: T })],
      ["pending that has already been answered", row({ consentStatus: "PENDING", consentRequestedAt: T, consentExpiresAt: T, consentRespondedAt: T })],
      ["solicited confirm with nobody recorded as answering", row({ consentStatus: "CONFIRMED", consentRequestedAt: T, consentRespondedAt: T })],
      ["expired that names a responder", row({ consentStatus: "EXPIRED", consentRequestedAt: T, consentExpiresAt: T, consentRespondedByMemberId: TARGET })],
      ["decline that was never requested", row({ consentStatus: "DECLINED", consentRespondedAt: T })],
      // A refusal is an attributed act — MG4's audit rides respondedBy.
      ["decline with nobody recorded as refusing", row({ consentStatus: "DECLINED", consentRequestedAt: T, consentRespondedAt: T })],
      // Both never-solicited shapes say expiresAt: "null" in the table. A
      // settled row carrying a live hold deadline is a broken row, not a
      // variant — MG2's sweep reads expiresAt and must never meet one.
      ["notify-only auto-confirm carrying a hold expiry", row({ consentStatus: "CONFIRMED", consentExpiresAt: T })],
      [
        "admin assignment carrying a hold expiry",
        row({
          consentStatus: "CONFIRMED",
          consentRespondedAt: T,
          consentRespondedByMemberId: ADMIN,
          consentExpiresAt: T,
        }),
      ],
    ];
    for (const [label, columns] of illegal) {
      expect(classifyMemberGuestConsent(columns, TARGET), label).toBeNull();
    }
  });

  it("keeps NULL and CONFIRMED as different answers", () => {
    // Said once more on its own, because it is the invariant most likely to be
    // "simplified" away by a later writer looking for one boolean.
    expect(classifyMemberGuestConsent(row(), TARGET)).toBe("FAMILY_OR_LEGACY");
    expect(classifyMemberGuestConsent(row({ consentStatus: "CONFIRMED" }), TARGET)).toBe(
      "NOTIFY_ONLY_AUTO_CONFIRMED",
    );
  });
});

// ---------------------------------------------------------------------------
// The two mirrors, GENERATED rather than eyeballed
// ---------------------------------------------------------------------------
// Asserting only that each sub-state ID appears somewhere in the docs proved
// nothing: a planted mutant that swapped a doc row's columns (or left a row
// stale after the code changed) passed happily, because the LABEL was still
// there. So each mirror line is now generated from the code table through the
// one mapping below and asserted verbatim. A shape that changes in code and not
// in the mirror fails here.
type SubState = (typeof MEMBER_GUEST_CONSENT_SUB_STATES)[number];

/** The vocabulary the table may use for a column's nullness. */
const NULLNESS_WORDS = ["set", "null", "any"] as const;

/** How each `respondedBy` word is spelled in the INV-GUEST consent table. */
const RESPONDER_DOC_WORDS: Record<string, string> = {
  null: "null",
  set: "set",
  any: "any",
  target: "the guest themselves",
  other: "someone other than the guest",
  admin: "the acting admin",
};

function statusWord(state: SubState): string {
  return state.status === null ? "NULL" : state.status;
}

/** One row of the eight-row table in docs/invariants/member-guest-consent.md. */
function docTableRow(state: SubState): string {
  const status = state.status === null ? "`NULL`" : `\`${state.status}\``;
  return [
    "",
    `\`${state.id}\``,
    status,
    state.requestedAt,
    state.respondedAt,
    RESPONDER_DOC_WORDS[state.respondedBy],
    state.expiresAt,
    "",
  ].join(" | ").trim();
}

/** One summary line of the `BookingGuest` schema comment. */
function schemaSummaryLine(state: SubState): string {
  return (
    `${state.id}: status ${statusWord(state)}` +
    ` / requestedAt ${state.requestedAt}` +
    ` / respondedAt ${state.respondedAt}` +
    ` / respondedBy ${state.respondedBy}` +
    ` / expiresAt ${state.expiresAt}`
  );
}

describe("the documented model matches the shipped one", () => {
  it("uses only the declared vocabulary for every column", () => {
    // The generators below are only meaningful while every word they translate
    // is one they know about.
    for (const state of MEMBER_GUEST_CONSENT_SUB_STATES) {
      expect(NULLNESS_WORDS, state.id).toContain(state.requestedAt);
      expect(NULLNESS_WORDS, state.id).toContain(state.respondedAt);
      expect(NULLNESS_WORDS, state.id).toContain(state.expiresAt);
      expect(
        Object.keys(RESPONDER_DOC_WORDS),
        `${state.id}: no doc spelling for respondedBy "${state.respondedBy}"`,
      ).toContain(state.respondedBy);
    }
  });

  it("is mirrored row-for-row in docs/invariants/member-guest-consent.md", () => {
    const invariants = readRepoFile("docs/invariants/member-guest-consent.md");
    for (const state of MEMBER_GUEST_CONSENT_SUB_STATES) {
      expect(
        invariants,
        `${state.id}: INV-GUEST is missing or stale for\n  ${docTableRow(state)}` +
          "\n  (docs/invariants/member-guest-consent.md — the consent sub-state table)",
      ).toContain(docTableRow(state));
    }
  });

  it("is mirrored line-for-line on the BookingGuest schema block", () => {
    const schema = readRepoFile("prisma/schema.prisma");
    expect(schema).toContain("MEMBER_GUEST_CONSENT_SUB_STATES");
    for (const state of MEMBER_GUEST_CONSENT_SUB_STATES) {
      expect(
        schema,
        `${state.id}: schema.prisma is missing or stale for\n  ${schemaSummaryLine(state)}`,
      ).toContain(schemaSummaryLine(state));
      // ...and every label the table names is a registered enum value.
      if (state.status !== null) {
        expect(schema).toMatch(new RegExp(`^\\s+${state.status}$`, "m"));
      }
    }
  });

  it("documents the shipped MG2 member-guest consent lifecycle in STATE_MACHINES.md", () => {
    const stateMachines = readRepoFile("docs/STATE_MACHINES.md");
    expect(stateMachines).toContain("## Member Guest Consent Lifecycle");
    expect(stateMachines).toContain("#2305 / MG2 #2307");
    expect(stateMachines).toContain("PENDING -> CONFIRMED");
    expect(stateMachines).not.toContain("unreachable until MG2");
  });
});

describe("member-guest policy singleton", () => {
  it("synthesises the shipped defaults when the row has never been saved", () => {
    // Lazy creation (D.19): a club that has never opened the settings reads
    // approval-required, a 7-day hold, and both privacy toggles off — and
    // nothing is written to get that answer.
    expect(normalizeMemberGuestSettings(null)).toEqual({
      approvalRequired: true,
      pendingHoldExpiryDays: 7,
      openMemberSearchEnabled: false,
      openMemberSearchIncludesMinors: false,
    });
    expect(normalizeMemberGuestSettings(undefined)).toEqual(DEFAULT_MEMBER_GUEST_SETTINGS);
  });

  it("fills only the columns a partial row is missing", () => {
    expect(
      normalizeMemberGuestSettings({ approvalRequired: false, pendingHoldExpiryDays: 3 }),
    ).toEqual({
      approvalRequired: false,
      pendingHoldExpiryDays: 3,
      openMemberSearchEnabled: false,
      openMemberSearchIncludesMinors: false,
    });
  });

  it("matches the schema column defaults", () => {
    // The defaults constant and the schema are two places one value has to
    // agree, and only one of them is what a fresh INSERT gets.
    const schema = readRepoFile("prisma/schema.prisma");
    expect(schema).toMatch(/approvalRequired\s+Boolean\s+@default\(true\)/);
    expect(schema).toMatch(/pendingHoldExpiryDays\s+Int\s+@default\(7\)/);
    expect(DEFAULT_MEMBER_GUEST_SETTINGS.approvalRequired).toBe(true);
    expect(DEFAULT_MEMBER_GUEST_SETTINGS.pendingHoldExpiryDays).toBe(7);
  });

  it("carries the 1..60 expiry bounds the owner confirmed", () => {
    expect(MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN).toBe(1);
    expect(MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX).toBe(60);
    expect(DEFAULT_MEMBER_GUEST_SETTINGS.pendingHoldExpiryDays).toBeGreaterThanOrEqual(
      MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN,
    );
    expect(DEFAULT_MEMBER_GUEST_SETTINGS.pendingHoldExpiryDays).toBeLessThanOrEqual(
      MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX,
    );
  });
});

describe("member-merge classification", () => {
  it("documents both new FK-less member-id scalars", () => {
    // The list is explicitly illustrative, so nothing fails if a column is
    // omitted — which is exactly why it is asserted here.
    const memberMerge = readRepoFile("src/lib/member-merge.ts");
    expect(memberMerge).toContain('"BookingGuest.consentRespondedByMemberId"');
    expect(memberMerge).toContain('"MemberGuestSettings.updatedByMemberId"');
  });

  it("adds no Member relation, so the DMMF completeness walk is untouched", () => {
    // Keeping consentRespondedByMemberId FK-less is what keeps this migration
    // off a validating constraint on the hot BookingGuest table — and it also
    // means MEMBER_MERGE_RELATION_SPECS needs no new row.
    const schema = readRepoFile("prisma/schema.prisma");
    const model = schema.slice(
      schema.indexOf("model BookingGuest {"),
      schema.indexOf("enum MemberGuestConsentStatus"),
    );
    expect(model).toContain("consentRespondedByMemberId String?");
    expect(model).not.toMatch(/consentRespondedByMemberId.*@relation/);
  });
});

describe("migrations", () => {
  const MIGRATIONS = [
    "prisma/migrations/20260731120000_add_member_guests_module_and_settings/migration.sql",
    "prisma/migrations/20260731120100_add_booking_guest_consent/migration.sql",
  ];

  it("writes no data at all", () => {
    // No seed row, no backfill, and therefore nothing for the session-clock DML
    // gate to catch. The singleton is created lazily on first write instead.
    for (const file of MIGRATIONS) {
      const sql = readRepoFile(file)
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");
      expect(sql, file).not.toMatch(/\bINSERT\b/i);
      expect(sql, file).not.toMatch(/\bUPDATE\b/i);
    }
  });

  it("adds the consent columns nullable, default-free, and without a foreign key", () => {
    // Every clause of that sentence is a lock the migration does not take on a
    // hot table: no default means no rewrite, no FK means no validation scan.
    const sql = readRepoFile(MIGRATIONS[1]);
    expect(sql).toContain('ALTER TABLE "BookingGuest" ADD COLUMN');
    expect(sql).not.toMatch(/ADD COLUMN[^;]*NOT NULL/i);
    expect(sql).not.toMatch(/ADD CONSTRAINT/i);
    expect(sql).not.toMatch(/REFERENCES/i);
  });

  it("uses a label only where the type it belongs to was just CREATEd", () => {
    // The honest version of what used to be asserted here. The index predicate
    // DOES name 'PENDING', so "registers the labels and never uses one" was
    // false — and the old assertion only passed because it exempted
    // CREATE INDEX, i.e. it exempted the single line that could have failed it.
    //
    // The real rationale is narrower and still holds: PostgreSQL refuses to use
    // a label added by ALTER TYPE ... ADD VALUE in the same transaction, but a
    // type created by CREATE TYPE in that transaction is usable straight away.
    // So what matters is that this migration CREATEs the type (it is brand new)
    // rather than ALTERing an existing one, and that the CREATE precedes the use.
    // Comments are stripped first: the header explains the ALTER TYPE contrast
    // in prose, and an assertion that read the whole file would trip on it.
    const statements = readRepoFile(MIGRATIONS[1])
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("--"));

    const createTypeAt = statements.findIndex((line) =>
      line.trim().startsWith('CREATE TYPE "MemberGuestConsentStatus"'),
    );
    expect(createTypeAt, "the enum type is not created here").toBeGreaterThan(-1);
    expect(
      statements.join("\n"),
      "an ALTER TYPE ADD VALUE label could NOT be used in this transaction",
    ).not.toMatch(/ALTER TYPE/i);

    // Exactly one statement names a label, it is the index predicate, and the
    // CREATE TYPE precedes it.
    const labelUses = statements
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /'PENDING'/.test(line) && !line.trim().startsWith("CREATE TYPE"));
    expect(labelUses).toHaveLength(1);
    expect(labelUses[0].line).toContain(
      'CREATE INDEX "BookingGuest_pendingConsent_expiresAt_idx"',
    );
    expect(createTypeAt).toBeLessThan(labelUses[0].index);

    // And no DML, so no ROW ever carries a label as a result of this migration —
    // which is what keeps the REVERSE blue/green direction safe (an old-colour
    // client can never read a value it cannot deserialise).
    expect(statements.join("\n")).not.toMatch(/\bINSERT\b|\bUPDATE\b/i);
  });

  it("records the partial index in the manifest Prisma cannot see", () => {
    const sql = readRepoFile(MIGRATIONS[1]);
    expect(sql).toContain('CREATE INDEX "BookingGuest_pendingConsent_expiresAt_idx"');
    const manifest = readRepoFile("prisma/partial-unique-indexes.tsv");
    expect(manifest).toContain("BookingGuest_pendingConsent_expiresAt_idx");
    expect(manifest).toContain("WHERE (\"consentStatus\" = 'PENDING'::\"MemberGuestConsentStatus\")");
  });

  it("has a blue/green ledger row for each, and a lock-impact plan on the hot one", () => {
    const ledger = readRepoFile("docs/BLUE_GREEN_MIGRATION_SAFETY.tsv")
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith("#"));
    const rows = MIGRATIONS.map((file) => {
      const name = file.split("/")[2];
      const row = ledger.find((line) => line.startsWith(`${name}\t`));
      expect(row, `no ledger row for ${name}`).toBeDefined();
      return row!.split("\t");
    });

    for (const [, phase, , oldCodeCompatible] of rows) {
      expect(phase).toBe("expand");
      expect(oldCodeCompatible).toBe("yes");
    }
    // The hot-table row has to argue BOTH blue/green directions. MG1 could
    // argue the reverse one away entirely, because nothing in that colour could
    // write an enum label. MG2 (#2307) falsified that, so the row was REWRITTEN
    // rather than left standing, and what is pinned here is that it now names the
    // real reverse-direction risk and the real mitigation — which is the module
    // flag, not the schema.
    const hotPlan = rows[1][4];
    expect(hotPlan.length).toBeGreaterThan(1000);
    expect(hotPlan).toContain("HOT_TABLE_SQL_REGEX");
    expect(hotPlan, "the row must not still claim the release is dark").not.toMatch(
      /ships DARK/i,
    );
    expect(hotPlan, "the row must name the rollback mitigation").toMatch(
      /turn the memberGuests module OFF first/i,
    );
    expect(hotPlan, "the row must be honest that PENDING rows hold beds on rollback").toMatch(
      /hold their beds/i,
    );

    // Lock honesty. The plan used to say the index build "briefly takes a SHARE
    // lock" and to offer CREATE INDEX CONCURRENTLY as the fix if BookingGuest
    // grew — neither of which is true inside a Prisma migration, because the
    // whole file runs in one transaction. Pin the corrected claims so an
    // optimistic rewrite cannot creep back.
    expect(hotPlan, "the plan must state the real lock held").toContain("ACCESS EXCLUSIVE");
    expect(hotPlan, "the plan must say the whole file is one transaction").toMatch(
      /ONE transaction/i,
    );
    expect(hotPlan, "an empty partial index still heap-scans").toMatch(
      /scans the entire heap|heap-scans/i,
    );
    expect(hotPlan).not.toMatch(/briefly takes a SHARE lock/i);
    expect(hotPlan).not.toMatch(/switch to CREATE INDEX CONCURRENTLY/i);
    expect(hotPlan, "CONCURRENTLY is impossible in a Prisma migration").toMatch(
      /forbids it inside a transaction block/i,
    );
  });
});

// --- MG2 (#2307): the operational-presence predicate ------------------------
//
// Owner decision D-12 says a non-consented guest is not operationally present:
// no kiosk arrivals row, no chore, no bed, no name in an arrival email, no line
// on the wall. Fourteen call sites spread across nine surfaces enforce that, and
// every one of them spreads one of the two forms declared here. If the two forms
// ever disagree, half the surfaces filter one way and half the other, and the
// disagreement is invisible in review.
//
// The NULL case is pinned first and hardest because it is the trap: NULL is the
// dominant value forever (every non-member guest, every family-scope add, every
// row written before this feature existed), and the hand-written filter a
// reviewer instinctively reaches for — { consentStatus: { not: "PENDING" } } —
// evaluates to UNKNOWN for NULL in SQL, silently emptying the kiosk and the
// arrival emails of every ordinary guest.
describe("operational-presence predicate (D-12)", () => {
  const ALL_STATUSES: Array<MemberGuestConsentStatus | null> = [
    null,
    "PENDING",
    "CONFIRMED",
    "DECLINED",
    "EXPIRED",
  ];

  /**
   * Evaluate the Prisma `where` fragment the way Postgres would, so the two
   * forms are compared on the same input rather than by reading them.
   *
   * Deliberately written as an equality match per OR branch (never `!==`), which
   * is exactly what Prisma emits for `{ consentStatus: null }` (IS NULL) and
   * `{ consentStatus: "CONFIRMED" }` (= 'CONFIRMED').
   */
  function whereMatches(consentStatus: MemberGuestConsentStatus | null): boolean {
    return OPERATIONALLY_PRESENT_GUEST_WHERE.OR.some(
      (branch) => branch.consentStatus === consentStatus,
    );
  }

  it("matches a NULL-consent guest — the Prisma-null trap", () => {
    // Both forms. A regression in either one empties the kiosk of every
    // ordinary guest, which is the single most expensive way this can fail.
    expect(whereMatches(null)).toBe(true);
    expect(isOperationallyPresentConsent(null)).toBe(true);

    // An unselected column arrives as undefined rather than null; treat it the
    // same, because a surface that forgot to select consentStatus must not
    // thereby hide every guest it holds.
    expect(isOperationallyPresentConsent(undefined)).toBe(true);

    // The trap itself, stated as a test: the `not` form the OR replaces would
    // have excluded NULL. This is what mutation probe 4 flips.
    expect(OPERATIONALLY_PRESENT_GUEST_WHERE).not.toHaveProperty("consentStatus");
    expect(JSON.stringify(OPERATIONALLY_PRESENT_GUEST_WHERE)).not.toContain("not");
  });

  it("agrees with isOperationallyPresentConsent over every column value", () => {
    for (const status of ALL_STATUSES) {
      expect(
        isOperationallyPresentConsent(status),
        `in-memory predicate disagrees with the where form for ${String(status)}`,
      ).toBe(whereMatches(status));
    }
  });

  it("admits NULL and CONFIRMED, and nothing else", () => {
    expect(ALL_STATUSES.filter((status) => whereMatches(status))).toEqual([
      null,
      "CONFIRMED",
    ]);
    // PENDING is the one that holds a bed (D-4) while being absent from every
    // operational surface (D-12); DECLINED and EXPIRED are rows that survived a
    // failed removal and are not occupants either.
    expect(isOperationallyPresentConsent("PENDING")).toBe(false);
    expect(isOperationallyPresentConsent("DECLINED")).toBe(false);
    expect(isOperationallyPresentConsent("EXPIRED")).toBe(false);
  });

  it("covers every status the enum can hold", () => {
    // If MG3/MG4 adds a status, this fails until the table above names it —
    // rather than the new status silently defaulting to "not present".
    const declared = new Set(
      MEMBER_GUEST_CONSENT_SUB_STATES.map((subState) => subState.status),
    );
    expect(new Set(ALL_STATUSES)).toEqual(declared);
  });
});

// --- MG2 (#2307): the expiry clamp -----------------------------------------
//
// Owner decision D-4 lets a `PENDING` request hold a bed so a booker is not made
// to race a stranger's inbox for capacity, and that is only defensible because
// the hold has a deadline. This is the function that sets it, and the deadline it
// picks is load-bearing in a way that is easy to miss on a read: it is
// `min(now + N days, the START of the day BEFORE check-in)`, never sooner than two
// hours away.
//
// THE DAY BEFORE, NOT CHECK-IN, IS THE WHOLE POINT. The sweep releases the bed
// through the same path a member's own self-removal uses, and that path refuses
// with STAY_NOT_FUTURE once the NZ-local check-in date is no longer in the future.
// An expiry clamped to check-in itself would therefore fire on a morning when the
// removal is already refused, and every such row would land on the admin
// exception list still holding its bed — exactly the outcome D-4's deadline
// exists to prevent. The "would fail if somebody simplified the clamp back to
// check-in" case below is named as such so a later reader cannot mistake the
// extra day for an off-by-one.
const NZ = requireClubTimeZone("Pacific/Auckland");
/**
 * A club BEHIND Greenwich, which is the only kind of deployment that can tell a
 * decoded stored day from one projected through the club's zone. Deliberately
 * not `Pacific/Auckland`: that is `APP_TIME_ZONE`'s own fallback, so a test
 * using it cannot distinguish the persisted zone from the environment's.
 */
const DENVER = requireClubTimeZone("America/Denver");
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/** A stored `@db.Date` lodge night, exactly as Prisma hands one back. */
const storedDay = (day: string) => dateOnlyInstantOf(requireCalendarDate(day));

/** The first instant of a club calendar day, for an expected value. */
const clubDayStart = (day: string, zone: typeof NZ) =>
  startOfClubDay(requireCalendarDate(day), zone);

describe("computeMemberGuestConsentExpiry", () => {
  it("gives the club's configured window when check-in is far away", () => {
    // Nothing binds: 30 days out, a 7-day policy, so the answer is just the
    // policy. This is the ordinary case and it is asserted first so the clamp
    // cases below cannot be read as the normal behaviour.
    const now = new Date("2026-08-01T02:00:00.000Z");
    expect(
      computeMemberGuestConsentExpiry({
        now,
        pendingHoldExpiryDays: 7,
        bookingCheckIn: storedDay("2026-08-31"),
        timeZone: NZ,
      }),
    ).toEqual(new Date("2026-08-08T02:00:00.000Z"));
  });

  it("clamps to the start of the day BEFORE check-in, not to check-in day", () => {
    // MUTATION PROBE (the clamp): change `addDaysDateOnly(..., -1)` to `0` — i.e.
    // "simplify" the clamp back to check-in — and this test fails on all three
    // assertions. The request is made three days out under a seven-day policy, so
    // the clamp binds and the two-hour floor does not.
    const now = new Date("2026-08-01T02:00:00.000Z");
    const expiry = computeMemberGuestConsentExpiry({
      now,
      pendingHoldExpiryDays: 7,
      bookingCheckIn: storedDay("2026-08-04"),
      timeZone: NZ,
    });

    // Midnight NZST on 3 August, the day before the 4 August check-in.
    expect(expiry).toEqual(new Date("2026-08-02T12:00:00.000Z"));

    const startOfCheckInDay = clubDayStart("2026-08-04", NZ);
    expect(expiry.getTime()).toBeLessThan(startOfCheckInDay.getTime());
    // And a full club day earlier, so the nightly 04:30 sweep gets a run on a
    // morning when the removal path still sees a future check-in.
    expect(startOfCheckInDay.getTime() - expiry.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("lands on the real NZ start-of-day when daylight saving ENDS between now and check-in", () => {
    // NZDT -> NZST on Sunday 5 April 2026 (clocks go back at 03:00). A check-in on
    // 6 April makes the clamp 5 April, whose local midnight is still NZDT (UTC+13)
    // — 11:00Z on the 4th. Two wrong-but-plausible implementations are excluded
    // explicitly below: UTC midnight of the clamp date, and "start of check-in day
    // minus 24 hours" (which is an hour out because the day the clock changes is
    // 25 hours long).
    const expiry = computeMemberGuestConsentExpiry({
      now: new Date("2026-04-01T00:00:00.000Z"),
      pendingHoldExpiryDays: 7,
      bookingCheckIn: storedDay("2026-04-06"),
      timeZone: NZ,
    });

    expect(expiry).toEqual(new Date("2026-04-04T11:00:00.000Z"));
    expect(expiry).not.toEqual(new Date("2026-04-05T00:00:00.000Z"));
    const startOfCheckInDay = clubDayStart("2026-04-06", NZ);
    expect(startOfCheckInDay.getTime() - expiry.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it("lands on the real NZ start-of-day when daylight saving STARTS between now and check-in", () => {
    // The other side of the year: NZST -> NZDT on Sunday 27 September 2026. A
    // check-in on the 28th clamps to the 27th, whose local midnight is still NZST
    // (UTC+12) — 12:00Z on the 26th. The 27th is only 23 hours long, so a naive
    // "check-in minus 24 hours" is again an hour out, in the opposite direction
    // from the April case. A single-date DST test would not have caught a sign
    // error; two, either side of the year, do.
    const expiry = computeMemberGuestConsentExpiry({
      now: new Date("2026-09-20T00:00:00.000Z"),
      pendingHoldExpiryDays: 7,
      bookingCheckIn: storedDay("2026-09-28"),
      timeZone: NZ,
    });

    expect(expiry).toEqual(new Date("2026-09-26T12:00:00.000Z"));
    const startOfCheckInDay = clubDayStart("2026-09-28", NZ);
    expect(startOfCheckInDay.getTime() - expiry.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("never mints a request that has already expired, even when the clamp is in the past", () => {
    // THE ONE CASE THE CLAMP CANNOT SAVE, and the function's own doc comment says
    // so rather than hiding it: a booking made the evening before check-in. The
    // clamp (midnight starting the day before check-in) is already behind us, so
    // the two-hour floor wins and the deadline lands ON check-in day — where the
    // sweep will meet STAY_NOT_FUTURE and route the row to the admin exception
    // list. That is the deliberate trade: an already-expired request would give
    // the member no chance to answer at all, which is worse.
    const now = new Date("2026-08-01T11:00:00.000Z"); // 23:00 NZST on 1 August
    const expiry = computeMemberGuestConsentExpiry({
      now,
      pendingHoldExpiryDays: 7,
      bookingCheckIn: storedDay("2026-08-02"),
      timeZone: NZ,
    });

    expect(expiry).toEqual(new Date(now.getTime() + TWO_HOURS_MS));
    expect(expiry.getTime()).toBeGreaterThanOrEqual(now.getTime() + TWO_HOURS_MS);
    // Stated plainly so nobody "fixes" it by silently expiring the request on
    // creation: this deadline really is on the check-in date in club time.
    expect(clubCalendarDateOf(expiry, NZ)).toBe("2026-08-02");
  });

  it("lets the two-hour floor overshoot a clamp that is nearer than two hours", () => {
    // The gentler version of the same edge: the clamp is only an hour away, so the
    // floor wins and overshoots it — but by little enough that the deadline is
    // still on the day before check-in and the sweep can still release the bed.
    const now = new Date("2026-08-01T11:00:00.000Z"); // 23:00 NZST on 1 August
    const clamp = clubDayStart("2026-08-02", NZ); // now + 1 hour
    const expiry = computeMemberGuestConsentExpiry({
      now,
      pendingHoldExpiryDays: 7,
      bookingCheckIn: storedDay("2026-08-03"),
      timeZone: NZ,
    });

    expect(expiry).toEqual(new Date(now.getTime() + TWO_HOURS_MS));
    expect(expiry.getTime()).toBeGreaterThan(clamp.getTime());
    expect(expiry.getTime()).toBeLessThan(
      clubDayStart("2026-08-03", NZ).getTime(),
    );
  });

  it("holds for at least two hours, matching the settlement reaper's floor", () => {
    // Mirrors MIN_GRACE_MS in cron-group-settlement-reaper.ts: never mint a hold
    // that has lapsed by the time the email announcing it lands.
    expect(MEMBER_GUEST_CONSENT_MIN_HOLD_MS).toBe(TWO_HOURS_MS);
  });

  /*
    THE TEST THAT USED TO BE HERE PINNED THE DEFAULT, and #3123 deleted it rather
    than adapting it.

    It read "defaults to club time rather than to the server's zone" and asserted
    that a call with NO `timeZone` equalled the same call with
    `timeZone: APP_TIME_ZONE`. That is a tautology dressed as a guarantee: the
    default WAS `APP_TIME_ZONE`, so the assertion could not fail, and what it
    actually pinned was the defect — the environment deciding a member's
    deadline. There is no version of it worth keeping once the parameter is
    required, because the property it claimed to protect is now enforced by the
    compiler at every call site instead. The two tests below are what replace it,
    and neither can pass by accident on a container that happens to run in the
    club's zone.
  */

  it("names the deadline in the CLUB's zone, not the container's", () => {
    /*
      A club in `America/Denver` — six or seven hours behind Greenwich, and
      deliberately NOT `Pacific/Auckland`, which is what the environment falls
      back to and so cannot be told apart from it.

      The clamp binds (three days out under a seven-day policy), so the answer is
      the first instant of 3 August AT THE CLUB. In Denver that is 06:00Z on the
      3rd; in Auckland it would have been 12:00Z on the 2nd — eighteen hours
      earlier and on the wrong calendar day. A deadline the club's own setting
      does not decide is the whole defect this epic exists to end.
    */
    const expiry = computeMemberGuestConsentExpiry({
      now: new Date("2026-08-01T02:00:00.000Z"),
      pendingHoldExpiryDays: 7,
      bookingCheckIn: storedDay("2026-08-04"),
      timeZone: DENVER,
    });

    expect(expiry).toEqual(new Date("2026-08-03T06:00:00.000Z"));
    expect(expiry).not.toEqual(clubDayStart("2026-08-03", NZ));
    expect(clubCalendarDateOf(expiry, DENVER)).toBe("2026-08-03");
  });

  it("gives a Denver member the SAME last day to answer as an Auckland one", () => {
    /*
      MEASURED, AND THIS IS THE ONE A MEMBER NOTICES (#3123).

      `bookingCheckIn` is a `@db.Date` column — a calendar day, encoded as UTC
      midnight — and the old code read it back THROUGH the club's zone before
      subtracting a day. For a club behind Greenwich that projection names the
      previous day, so "the day before check-in" came out a day early and the
      whole deadline moved 24 hours earlier: measured at exactly 86,400,000 ms on
      `America/Denver`.

      What that costs a person: the request email says "answer by", the consent
      card says "expires", and the nightly sweep releases their bed. A Denver
      member asked to approve a 4 August stay was given until 2 August and told
      so, where the club's policy — and every Auckland member — gets the 3rd.

      The assertion is written as the DAY each member is given rather than as an
      instant equality, because the instants legitimately differ (a club day
      starts at a different moment in each zone) while the day must not.

      MUTATION PROBE: put the projection back — decode `bookingCheckIn` with
      `clubCalendarDateOf(bookingCheckIn, timeZone)` instead of
      `calendarDateOfDateOnlyInstant` — and the Denver leg reads "2026-08-02"
      while the Auckland leg stays "2026-08-03".
    */
    const args = {
      now: new Date("2026-08-01T02:00:00.000Z"),
      pendingHoldExpiryDays: 7,
      bookingCheckIn: storedDay("2026-08-04"),
    };

    const denver = computeMemberGuestConsentExpiry({ ...args, timeZone: DENVER });
    const auckland = computeMemberGuestConsentExpiry({ ...args, timeZone: NZ });

    expect(clubCalendarDateOf(denver, DENVER)).toBe("2026-08-03");
    expect(clubCalendarDateOf(auckland, NZ)).toBe("2026-08-03");
  });

  it("refuses a real timestamp where a stored lodge night belongs", () => {
    // The precondition is asserted, not assumed. A bare `Date` cannot say
    // whether it encodes a calendar day or holds a moment, and a moment decoded
    // in UTC would be the INV-DATE-019 defect from the other direction — silently
    // right for a club east of Greenwich and wrong everywhere else.
    expect(() =>
      computeMemberGuestConsentExpiry({
        now: new Date("2026-08-01T02:00:00.000Z"),
        pendingHoldExpiryDays: 7,
        bookingCheckIn: new Date("2026-08-04T09:30:00.000Z"),
        timeZone: DENVER,
      }),
    ).toThrow(/takes a stored calendar day, not a moment/);
  });
});

// --- MG2 (#2307): the single writer of consent columns ----------------------
//
// Three inputs — the family boundary (D-6), the club's approvalRequired policy
// (D-3) and who is doing the adding (MG4-D-a, brought forward) — are two states
// each, so there are eight ways to call this function. The table below is all
// eight, because the interesting property is not that each rule works in
// isolation but that the three of them compose to exactly four legal column sets
// and nothing else.
//
// The round-trip at the end is what makes the table binding rather than
// descriptive: every column set the writer returns is fed straight back through
// `classifyMemberGuestConsent` and must classify non-null, AND to the very
// sub-state the writer claimed. Without it a writer could invent a shape the
// model does not define — a CONFIRMED row carrying a hold deadline, say — and the
// eight-shape table would quietly stop being the truth about what is in the
// database.
describe("buildMemberGuestConsentWrite", () => {
  const NOW = new Date("2026-08-01T02:00:00.000Z");
  const EXPIRY = new Date("2026-08-08T02:00:00.000Z");
  const MEMBER_ACTOR: MemberGuestAddActor = { kind: "MEMBER" };
  const ADMIN_ACTOR: MemberGuestAddActor = { kind: "ADMIN", adminMemberId: ADMIN };

  /** All eight ways to call the writer, and the one answer each must give. */
  const CASES: Array<{
    label: string;
    scope: MemberGuestBoundaryScope;
    approvalRequired: boolean;
    actor: MemberGuestAddActor;
    subState: string;
    notification: string;
    columns: MemberGuestConsentColumns;
  }> = [
    // D-6: a family-scope add is consent-FREE, and the club's approval policy and
    // the actor are both irrelevant to it — nobody is asked, nobody is told, and
    // the row is indistinguishable from every pre-feature guest row. All four
    // family rows are listed rather than collapsed, because "the policy does not
    // reach inside a family" is the assertion.
    ...(
      [
        ["approval-required policy, member adding", true, MEMBER_ACTOR],
        ["approval-required policy, admin adding", true, ADMIN_ACTOR],
        ["notify-only policy, member adding", false, MEMBER_ACTOR],
        ["notify-only policy, admin adding", false, ADMIN_ACTOR],
      ] as const
    ).map(([label, approvalRequired, actor]) => ({
      label: `family scope — ${label}`,
      scope: "FAMILY" as MemberGuestBoundaryScope,
      approvalRequired,
      actor,
      subState: "FAMILY_OR_LEGACY",
      notification: "NONE",
      columns: {
        consentStatus: null,
        consentRequestedAt: null,
        consentRespondedAt: null,
        consentRespondedByMemberId: null,
        consentExpiresAt: null,
      },
    })),
    // MG4-D-a, brought forward into MG2 so no released state can mint a PENDING
    // row a later release would have had to migrate away: an admin add is
    // consent-free and always-notify, and the club's approval policy does not
    // change that. The row still records CONFIRMED against the admin who stood
    // behind it, which is where MG4's audit rides.
    ...([true, false] as const).map((approvalRequired) => ({
      label: `admin actor — ${approvalRequired ? "approval-required" : "notify-only"} policy`,
      scope: "BEYOND_FAMILY" as MemberGuestBoundaryScope,
      approvalRequired,
      actor: ADMIN_ACTOR,
      subState: "ADMIN_ASSIGNED",
      notification: "ADDED_NOTICE",
      columns: {
        consentStatus: "CONFIRMED" as const,
        consentRequestedAt: null,
        consentRespondedAt: NOW,
        consentRespondedByMemberId: ADMIN,
        consentExpiresAt: null,
      },
    })),
    {
      label: "member add under the shipped approval-required default (D-3)",
      scope: "BEYOND_FAMILY",
      approvalRequired: true,
      actor: MEMBER_ACTOR,
      subState: "AWAITING_TARGET",
      notification: "CONSENT_REQUEST",
      columns: {
        consentStatus: "PENDING",
        consentRequestedAt: NOW,
        consentRespondedAt: null,
        consentRespondedByMemberId: null,
        consentExpiresAt: EXPIRY,
      },
    },
    {
      label: "member add at a club that opted down to notify-only (D-3)",
      scope: "BEYOND_FAMILY",
      approvalRequired: false,
      actor: MEMBER_ACTOR,
      subState: "NOTIFY_ONLY_AUTO_CONFIRMED",
      notification: "ADDED_NOTICE",
      columns: {
        // CONFIRMED with a null requestedAt AND a null respondedBy is the
        // signature of a consent nobody ever actually solicited. expiresAt stays
        // null: a CONFIRMED row carrying a deadline would look to the sweep like
        // a live hold.
        consentStatus: "CONFIRMED",
        consentRequestedAt: null,
        consentRespondedAt: null,
        consentRespondedByMemberId: null,
        consentExpiresAt: null,
      },
    },
  ];

  it("covers all eight ways the three inputs can combine", () => {
    expect(CASES).toHaveLength(8);
  });

  for (const testCase of CASES) {
    it(`writes ${testCase.subState} for ${testCase.label}`, () => {
      const write = buildMemberGuestConsentWrite({
        scope: testCase.scope,
        approvalRequired: testCase.approvalRequired,
        actor: testCase.actor,
        now: NOW,
        consentExpiresAt: EXPIRY,
      });

      expect(write.columns).toEqual(testCase.columns);
      expect(write.notification).toBe(testCase.notification);
      expect(write.subState).toBe(testCase.subState);
    });
  }

  it("classifies every shape it writes back to the sub-state it claimed", () => {
    // The round trip, and the reason the eight-row table above is worth having.
    // The writer's `subState` is a claim about the columns it just returned; this
    // is where the claim is checked against the model's own classifier, for the
    // target themselves (the guest's memberId) rather than for some third party.
    for (const testCase of CASES) {
      const write = buildMemberGuestConsentWrite({
        scope: testCase.scope,
        approvalRequired: testCase.approvalRequired,
        actor: testCase.actor,
        now: NOW,
        consentExpiresAt: EXPIRY,
      });

      const classified = classifyMemberGuestConsent(write.columns, TARGET);
      expect(classified, `${testCase.label}: the writer produced an undefined shape`).not.toBeNull();
      expect(classified, testCase.label).toBe(write.subState);
    }
  });

  it("reaches exactly four of the eight sub-states, and leaves the rest to the state machine", () => {
    // A closed world in the other direction. The add path can only ever produce
    // these four; TARGET_APPROVED, DELEGATE_APPROVED, DECLINED and EXPIRED are
    // reachable only through respondToMemberGuestConsent and the expiry sweep. If
    // a future add path starts writing one of those four, this fails and somebody
    // has to say why an add is answering a question nobody asked.
    const reachable = new Set(CASES.map((testCase) => testCase.subState));
    expect([...reachable].sort()).toEqual([
      "ADMIN_ASSIGNED",
      "AWAITING_TARGET",
      "FAMILY_OR_LEGACY",
      "NOTIFY_ONLY_AUTO_CONFIRMED",
    ]);

    const unreachableHere = MEMBER_GUEST_CONSENT_SUB_STATES.map((state) => state.id).filter(
      (id) => !reachable.has(id),
    );
    expect(unreachableHere).toEqual([
      "TARGET_APPROVED",
      "DELEGATE_APPROVED",
      "DECLINED",
      "EXPIRED",
    ]);
  });

  it("refuses to write a PENDING hold with no deadline", () => {
    // Not defensive padding. The sweep finds lapsed holds through the partial
    // index on (consentStatus = 'PENDING', consentExpiresAt), so a PENDING row
    // with a null expiry is invisible to it and would hold its bed until the stay
    // had been and gone — the one outcome D-4's deadline exists to prevent. The
    // writer would rather fail the add than create that row.
    for (const consentExpiresAt of [undefined, null]) {
      expect(() =>
        buildMemberGuestConsentWrite({
          scope: "BEYOND_FAMILY",
          approvalRequired: true,
          actor: MEMBER_ACTOR,
          now: NOW,
          consentExpiresAt,
        }),
      ).toThrow(/needs a consentExpiresAt/);
    }
  });

  it("ignores a stray expiry on the shapes that must not carry one", () => {
    // A caller that passes consentExpiresAt unconditionally (the obvious way to
    // write the call site, since only one shape needs it) must not thereby stamp a
    // hold deadline onto a settled CONFIRMED row. The classifier rejects that
    // shape outright, so this is the assertion that keeps the call sites simple.
    for (const testCase of CASES.filter((c) => c.subState !== "AWAITING_TARGET")) {
      const write = buildMemberGuestConsentWrite({
        scope: testCase.scope,
        approvalRequired: testCase.approvalRequired,
        actor: testCase.actor,
        now: NOW,
        consentExpiresAt: EXPIRY,
      });
      expect(write.columns.consentExpiresAt, testCase.label).toBeNull();
    }
  });
});
