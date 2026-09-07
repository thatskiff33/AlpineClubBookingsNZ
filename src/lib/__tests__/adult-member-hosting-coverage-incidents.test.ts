// #2576 §7, §8, §14, §16 — the durable side of same-owner coverage: the officer's
// compliance incident, the bounded re-evaluation queue, and the drain that joins
// them.
//
// Everything here is about behaviour a reconciliation can only get wrong the SECOND
// time it runs: a duplicated incident, a repeated "you have lost your cover" email,
// an incident left standing after the problem went away, a poison queue item
// retried forever. Those are the failures the owner's text names, and none of them
// is visible from a single happy-path call.
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  HOSTING_COVERAGE_OWNER_NOTIFICATION_LEASE_MS,
  claimHostingCoverageOwnerNotification,
  completeHostingCoverageOwnerNotification,
  hostingCoverageStateKey,
  isHostingCoverageOwnerNotificationPending,
  loadHostingCoverageOwnerNotificationDelivery,
  openOrUpdateHostingCoverageIncident,
  releaseHostingCoverageOwnerNotification,
  resolveHostingCoverageIncidents,
} from "@/lib/adult-member-hosting-coverage-incidents";
import {
  claimHostingCoverageReevaluations,
  completeHostingCoverageReevaluation,
  deferHostingCoverageReevaluation,
  enqueueHostingCoverageReevaluation,
  failHostingCoverageReevaluation,
  loadClaimedHostingCoverageReevaluation,
  releaseHostingCoverageReevaluationContention,
  renewHostingCoverageReevaluationClaim,
} from "@/lib/adult-member-hosting-coverage-queue";
import { acquireHostingCoverageQueueParticipantProof } from "@/lib/adult-member-hosting-queue-participants";
import type { AdultMemberHostingPolicyExceptionViolation } from "@/lib/booking-policy-exceptions";

function violation(
  uncovered: Array<{ guestRef: string; night: string }>,
  overrides: Partial<AdultMemberHostingPolicyExceptionViolation> = {},
): AdultMemberHostingPolicyExceptionViolation {
  return {
    reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
    consequence: "ENFORCED",
    policyId: "policy-club",
    policyVersion: 7,
    policyName: "Adult member hosting requirement",
    resolvedScope: { kind: "CLUB_WIDE", lodgeId: null, effectiveLodgeId: "lodge-a" },
    affectedNights: [...new Set(uncovered.map((row) => row.night))].sort(),
    requirements: {
      kind: "ADULT_MEMBER_HOSTING",
      requiredAdultMemberParticipantsPerGuestNight: 1,
      uncoveredNonMemberGuestNights: uncovered.length,
      uncovered: uncovered.map((row) => ({
        guestRef: row.guestRef,
        guestName: `${row.guestRef} Person`,
        night: row.night,
      })),
      qualifyingHostsByNight: [],
      enabledHostScopes: ["SAME_BOOKING", "SAME_BOOKING_OWNER"],
    },
    exceptionEligible: true,
    capacityMode: "NO_HOLD",
    message: "uncovered",
    ...overrides,
  } as unknown as AdultMemberHostingPolicyExceptionViolation;
}

/** An in-memory incident table with the partial unique index's behaviour. */
function makeIncidentDb(
  seed: Array<Record<string, unknown>> = [],
  options: { failFirstCreate?: boolean } = {},
) {
  const rows: Array<Record<string, unknown>> = seed.map((row) => ({ ...row }));
  let createAttempts = 0;
  const audits: Array<Record<string, unknown>> = [];

  const db = {
    hostingCoverageIncident: {
      findFirst: vi.fn(async ({ where }: any) =>
        rows.find(
          (row) =>
            row.bookingId === where.bookingId &&
            (where.resolvedAt === null ? row.resolvedAt == null : true),
        ) ?? null,
      ),
      create: vi.fn(async ({ data }: any) => {
        createAttempts += 1;
        // The partial unique index: at most one row per booking with resolvedAt
        // NULL. `failFirstCreate` simulates losing that race to a concurrent
        // opener whose row was not visible to the read above.
        const active = rows.find(
          (row) => row.bookingId === data.bookingId && row.resolvedAt == null,
        );
        if (active || (options.failFirstCreate && createAttempts === 1)) {
          if (options.failFirstCreate && createAttempts === 1 && !active) {
            rows.push({
              id: "incident-winner",
              ...data,
              stateKey: "v1:somebody-elses-key",
              resolvedAt: null,
            });
          }
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "test",
          });
        }
        const created = { id: `incident-${rows.length + 1}`, ...data, resolvedAt: null };
        rows.push(created);
        return { id: created.id };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        Object.assign(
          rows.find((row) => row.id === where.id)!,
          data,
        );
        return {};
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const matched = rows.filter((row) => {
          if (where.id !== undefined && row.id !== where.id) return false;
          if (where.bookingId !== undefined && row.bookingId !== where.bookingId) {
            return false;
          }
          if (where.resolvedAt === null && row.resolvedAt != null) return false;
          if (where.stateKey !== undefined && row.stateKey !== where.stateKey) {
            return false;
          }
          if (where.cause !== undefined) {
            // `{ notIn: [...] }` and `{ not: value }` as well as a bare label.
            // The promotion guard excludes the causes this write does NOT
            // outrank (#3241), so a label no build knows still matches; before
            // that it named one label (#3232 D3).
            // `HostingCoverageIncident.cause` is NOT NULL, so plain (in)equality
            // is faithful here - there is no three-valued case to model, unlike
            // the nullable notification columns below.
            const filter = where.cause;
            const matchesCause =
              filter !== null && typeof filter === "object"
                ? "notIn" in filter
                  ? !(filter.notIn as string[]).includes(String(row.cause))
                  : row.cause !== filter.not
                : row.cause === filter;
            if (!matchesCause) return false;
          }
          if (where.OR !== undefined) {
            const matchesNotificationState = where.OR.some((branch: any) => {
              const filter = branch.notifiedStateKey;
              if (filter === null) return row.notifiedStateKey == null;
              if (filter?.not !== undefined) {
                // Faithful to PostgreSQL three-valued logic: `NULL <> value` is
                // UNKNOWN and does not match. The explicit OR-null branch above
                // is therefore required for the first notification.
                return (
                  row.notifiedStateKey != null &&
                  row.notifiedStateKey !== filter.not
                );
              }
              return row.notifiedStateKey === filter;
            });
            if (!matchesNotificationState) return false;
          }
          if (where.AND !== undefined) {
            const claimFilter = where.AND[0]?.OR ?? [];
            const claimAvailable = claimFilter.some((branch: any) => {
              if (branch.ownerNotificationClaimStateKey === null) {
                return row.ownerNotificationClaimStateKey == null;
              }
              if (branch.ownerNotificationClaimStateKey?.not !== undefined) {
                return (
                  row.ownerNotificationClaimStateKey != null &&
                  row.ownerNotificationClaimStateKey !==
                    branch.ownerNotificationClaimStateKey.not
                );
              }
              if (branch.ownerNotificationClaimedAt?.lt instanceof Date) {
                return (
                  row.ownerNotificationClaimedAt instanceof Date &&
                  row.ownerNotificationClaimedAt <
                    branch.ownerNotificationClaimedAt.lt
                );
              }
              return false;
            });
            if (!claimAvailable) return false;
          }
          if (
            where.ownerNotificationClaimStateKey !== undefined &&
            row.ownerNotificationClaimStateKey !==
              where.ownerNotificationClaimStateKey
          ) {
            return false;
          }
          if (
            where.ownerNotificationClaimToken !== undefined &&
            row.ownerNotificationClaimToken !== where.ownerNotificationClaimToken
          ) {
            return false;
          }
          return true;
        });
        for (const row of matched) Object.assign(row, data);
        return { count: matched.length };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        audits.push(data);
        return {};
      }),
    },
  } as any;

  return { db, rows, audits };
}

describe("the material-identity fingerprint (#2576 §16)", () => {
  it("is stable for the same uncovered state and different for a different one", () => {
    const a = hostingCoverageStateKey(
      violation([
        { guestRef: "kid", night: "2026-07-03" },
        { guestRef: "kid", night: "2026-07-04" },
      ]),
    );
    const b = hostingCoverageStateKey(
      violation([
        { guestRef: "kid", night: "2026-07-03" },
        { guestRef: "kid", night: "2026-07-04" },
      ]),
    );
    const c = hostingCoverageStateKey(
      violation([{ guestRef: "kid", night: "2026-07-03" }]),
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("moves when the policy revision moves, so an old key cannot suppress a new problem", () => {
    const before = hostingCoverageStateKey(
      violation([{ guestRef: "kid", night: "2026-07-03" }]),
    );
    const after = hostingCoverageStateKey(
      violation([{ guestRef: "kid", night: "2026-07-03" }], {
        policyVersion: 8,
      } as never),
    );
    expect(before).not.toBe(after);
  });

  it("is fixed-width and version-prefixed whatever the party size", () => {
    const small = hostingCoverageStateKey(
      violation([{ guestRef: "kid", night: "2026-07-03" }]),
    );
    const huge = hostingCoverageStateKey(
      violation(
        Array.from({ length: 400 }, (_, index) => ({
          guestRef: `guest-${index}`,
          night: "2026-07-03",
        })),
      ),
    );
    // A stored key that could be truncated would make two different problems
    // compare equal, which is how an override on one night silences another.
    expect(small).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(huge).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(huge.length).toBe(small.length);
  });
});

describe("one active incident per booking, created or folded into (#2576 §16)", () => {
  const UNCOVERED = violation([{ guestRef: "kid", night: "2026-07-03" }]);

  it("opens an incident and audits it as something an officer must look at", async () => {
    const { db, rows, audits } = makeIncidentDb();
    const outcome = await openOrUpdateHostingCoverageIncident(
      {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "SYSTEM_CHANGE",
        violation: UNCOVERED,
      },
      db,
    );
    expect(outcome.action).toBe("opened");
    expect(rows).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "booking.hostingCoverage.incidentOpened",
      severity: "important",
      entityType: "Booking",
      entityId: "b-main",
    });
    // NO AUTOMATIC CANCELLATION (§7, §16): this module writes no booking column at
    // all, which is why `booking` is not even in its client type.
    expect(Object.keys(db)).toEqual(["hostingCoverageIncident", "auditLog"]);
  });

  it("records a reason with NO override in the history, and attributes nobody", async () => {
    // #3232 D3, `INV-HOST-052`. The owner was offered the linked move on their
    // own other booking and declined it. That is not an override - nobody
    // exercised authority over a booking that was not theirs - so the reason is
    // history rather than a stored mandatory reason, and no officer is named.
    // Until this landed the reason was computed, carried on the queue item all
    // the way to this function, and then dropped, so the only officer-facing
    // record of a deliberate decision was a cause code that also means "a
    // qualification changed".
    const { db, rows, audits } = makeIncidentDb();
    await openOrUpdateHostingCoverageIncident(
      {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "SYSTEM_CHANGE",
        violation: UNCOVERED,
        recordedReason: "The member was offered the linked move and declined it.",
      },
      db,
    );

    expect(audits[0]).toMatchObject({
      action: "booking.hostingCoverage.incidentOpened",
      details: "The member was offered the linked move and declined it.",
      // #3232 D3: AND IT IS REACHABLE FROM THE BOOKING. The booking page's own
      // history reads `auditLog.targetId = booking.id`, so without this the
      // recorded explanation lived only in Admin -> Monitoring & Support -> Audit
      // Log — while both the officer queue's "Review booking" button and the
      // stuck-state row send an officer to the booking page, where they saw the
      // generic cause and nothing else. D3's whole justification is that an
      // officer reading the booking's history sees the decision.
      targetId: "b-main",
    });
    // Actorless. `createAuditLog` maps a null actor to `undefined` so Prisma
    // omits the column, which is why this reads the key rather than matching
    // null; the officer-attribution test below is what proves a REAL id is not
    // being dropped the same way.
    expect(audits[0].actorMemberId ?? null).toBeNull();
    // NOT onto the override columns, which would report a decision an officer
    // never made.
    expect(rows[0]).toMatchObject({
      cause: "SYSTEM_CHANGE",
      overriddenByMemberId: null,
      overrideReason: null,
    });
  });

  it("still puts an officer's mandatory reason in the history and on the row", async () => {
    // The other half of the one derivation: an override's reason is stored AND
    // audited, and adding the history-only field did not divert it.
    const { db, rows, audits } = makeIncidentDb();
    await openOrUpdateHostingCoverageIncident(
      {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "OFFICER_OVERRIDE",
        violation: UNCOVERED,
        override: { byMemberId: "officer-1", reason: "Spoke with the family" },
      },
      db,
    );

    expect(audits[0]).toMatchObject({
      details: "Spoke with the family",
      actorMemberId: "officer-1",
    });
    expect(rows[0]).toMatchObject({
      overriddenByMemberId: "officer-1",
      overrideReason: "Spoke with the family",
    });
  });

  it("lets an officer override promote ANY non-override cause, not just SYSTEM_CHANGE", async () => {
    // The promotion guard used to name `cause: "SYSTEM_CHANGE"`. With a third
    // label registered (#3232 D3) that made an officer's override silently
    // impossible for a declined linked move: the guarded updateMany would match
    // nothing, the loop would exhaust, and the caller would get the retry error
    // instead of a recorded officer decision. Identical behaviour while only two
    // labels are in use, which is why nothing else caught it.
    //
    // THE CASE IS NOW REACHABLE. The label was registered one release before
    // anything wrote it (`INV-HOST-052`), so this test named an unwritten value
    // when it was written; #3241 added the writer, and a declined linked move an
    // officer then overrides is the live path through this branch.
    const { db, rows } = makeIncidentDb([
      {
        id: "incident-1",
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "OWNER_DECLINED_LINKED_MOVE",
        stateKey: hostingCoverageStateKey(UNCOVERED),
        resolvedAt: null,
      },
    ]);

    const outcome = await openOrUpdateHostingCoverageIncident(
      {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "OFFICER_OVERRIDE",
        violation: UNCOVERED,
        override: { byMemberId: "officer-1", reason: "Approved the exception" },
      },
      db,
    );

    expect(outcome.action).toBe("updated");
    expect(rows[0]).toMatchObject({
      cause: "OFFICER_OVERRIDE",
      overriddenByMemberId: "officer-1",
      overrideReason: "Approved the exception",
    });
  });

  it.each([
    ["sweep-first", false],
    ["decision-first", true],
  ] as const)(
    "records the member's decision whichever drain gets there first (%s)",
    async (_label, decisionFirst) => {
      // #3241, `INV-HOST-053`. The drain gives a re-evaluation row's explanation
      // only to the booking that row is about, so a stranded booking can be
      // opened first by a sweep that knows nothing — a bare `SYSTEM_CHANGE` — and
      // reached only afterwards by its own row carrying the decision. Without a
      // promotion for the same uncovered state, drain order would decide whether
      // an officer is ever told a member chose this, and the count of declines a
      // club judges its own setting by would be short.
      const { db, rows, audits } = makeIncidentDb();
      const sweep = {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "SYSTEM_CHANGE" as const,
        violation: UNCOVERED,
      };
      const decision = {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "OWNER_DECLINED_LINKED_MOVE" as const,
        violation: UNCOVERED,
        recordedReason: "The member was asked and chose to move only that one",
      };

      const order = decisionFirst ? [decision, sweep] : [sweep, decision];
      for (const params of order) {
        await openOrUpdateHostingCoverageIncident(params, db);
      }

      expect(rows.filter((row) => row.resolvedAt == null)).toHaveLength(1);
      expect(
        rows[0],
        "INV-HOST-053: the explained cause wins for the same uncovered state, whichever drain arrives first",
      ).toMatchObject({
        cause: "OWNER_DECLINED_LINKED_MOVE",
        // No officer is invented on the way through: this is not an override.
        overriddenByMemberId: null,
        overrideReason: null,
      });
      // The words land too, and only once — the unexplained write adds no event.
      const withReason = audits.filter(
        (audit: any) =>
          audit.details === "The member was asked and chose to move only that one",
      );
      expect(withReason).toHaveLength(1);
    },
  );

  it("lets an officer's override promote a member's decision, keeping §7's reason", async () => {
    // THE RANK IS THREE-VALUED AND THIS IS THE STEP THAT PROVES IT (#3241). With
    // `OFFICER_OVERRIDE` and `OWNER_DECLINED_LINKED_MOVE` both ranked 1, every
    // other case in this file still passes — and an officer overriding a booking
    // whose incident already records the member's decision would be dropped as
    // `unchanged`, losing the mandatory reason §7 exists to capture.
    const { db, rows } = makeIncidentDb();
    await openOrUpdateHostingCoverageIncident(
      {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "OWNER_DECLINED_LINKED_MOVE",
        violation: UNCOVERED,
        recordedReason: "The member was asked and chose to move only that one",
      },
      db,
    );
    const promoted = await openOrUpdateHostingCoverageIncident(
      {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "OFFICER_OVERRIDE",
        violation: UNCOVERED,
        override: { byMemberId: "officer-1", reason: "Approved the exception" },
      },
      db,
    );

    expect(promoted.action).toBe("updated");
    expect(rows[0]).toMatchObject({
      cause: "OFFICER_OVERRIDE",
      overriddenByMemberId: "officer-1",
      overrideReason: "Approved the exception",
    });
  });

  it("leaves the owner-notification claim alone when only the story changes", async () => {
    // #3241. `updateData` nulls the claim columns, which is right when the
    // uncovered state MOVED and wrong for a promotion: nothing about the hazard
    // changed. Clearing a claim held by a delivery in flight loses its completion
    // stamp, and the owner is emailed about the same unchanged condition twice
    // (§16). The state key is identical here, so the claim must survive.
    const { db, rows } = makeIncidentDb();
    await openOrUpdateHostingCoverageIncident(
      {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "SYSTEM_CHANGE",
        violation: UNCOVERED,
      },
      db,
    );
    rows[0].ownerNotificationClaimStateKey = hostingCoverageStateKey(UNCOVERED);
    rows[0].ownerNotificationClaimToken = "claim-in-flight";
    rows[0].ownerNotificationClaimedAt = new Date();

    await openOrUpdateHostingCoverageIncident(
      {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "OWNER_DECLINED_LINKED_MOVE",
        violation: UNCOVERED,
        recordedReason: "The member was asked and chose to move only that one",
      },
      db,
    );

    expect(rows[0]).toMatchObject({
      cause: "OWNER_DECLINED_LINKED_MOVE",
      ownerNotificationClaimToken: "claim-in-flight",
    });
  });

  it("does not let an officer's override be demoted to a member's decision", async () => {
    // The rank runs one way only. An override outranks everything, and a later
    // declined-move row for the same uncovered state must leave the officer's
    // name and mandatory reason exactly where they are (#3241, §7).
    const { db, rows } = makeIncidentDb();
    await openOrUpdateHostingCoverageIncident(
      {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "OFFICER_OVERRIDE",
        violation: UNCOVERED,
        override: { byMemberId: "officer-1", reason: "Spoke with the family" },
      },
      db,
    );
    const second = await openOrUpdateHostingCoverageIncident(
      {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "OWNER_DECLINED_LINKED_MOVE",
        violation: UNCOVERED,
        recordedReason: "The member was asked and chose to move only that one",
      },
      db,
    );

    expect(second.action).toBe("unchanged");
    expect(
      rows[0],
      "INV-HOST-053: the rank runs one way only — an override is never demoted",
    ).toMatchObject({
      cause: "OFFICER_OVERRIDE",
      overriddenByMemberId: "officer-1",
      overrideReason: "Spoke with the family",
    });
  });

  it("writes nothing the second time for the identical uncovered state", async () => {
    const { db, rows, audits } = makeIncidentDb();
    const params = {
      bookingId: "b-main",
      lodgeId: "lodge-a",
      cause: "SYSTEM_CHANGE" as const,
      violation: UNCOVERED,
    };
    await openOrUpdateHostingCoverageIncident(params, db);
    const second = await openOrUpdateHostingCoverageIncident(params, db);
    expect(second.action).toBe("unchanged");
    expect(rows).toHaveLength(1);
    // One audit row, not two: the drain is at-least-once, and an "officer, look at
    // this" event per sweep would bury the ones that are new.
    expect(audits).toHaveLength(1);
  });

  it.each([
    ["system-first", false],
    ["officer-first", true],
  ] as const)(
    "keeps officer cause, actor and reason when identical-state drains race (%s)",
    async (_label, officerFirst) => {
      const { db, rows } = makeIncidentDb();
      const system = {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "SYSTEM_CHANGE" as const,
        violation: UNCOVERED,
      };
      const officer = {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "OFFICER_OVERRIDE" as const,
        violation: UNCOVERED,
        override: {
          byMemberId: "officer-1",
          reason: "Approved after speaking with the family",
        },
      };

      await Promise.all(
        officerFirst
          ? [
              openOrUpdateHostingCoverageIncident(officer, db),
              openOrUpdateHostingCoverageIncident(system, db),
            ]
          : [
              openOrUpdateHostingCoverageIncident(system, db),
              openOrUpdateHostingCoverageIncident(officer, db),
            ],
      );

      expect(rows.filter((row) => row.resolvedAt == null)).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        stateKey: hostingCoverageStateKey(UNCOVERED),
        cause: "OFFICER_OVERRIDE",
        overriddenByMemberId: "officer-1",
        overrideReason: "Approved after speaking with the family",
      });
      const retry = await openOrUpdateHostingCoverageIncident(officer, db);
      expect(retry.action).toBe("unchanged");
      expect(rows.filter((row) => row.resolvedAt == null)).toHaveLength(1);
    },
  );

  it("never lets a later identical SYSTEM_CHANGE drain downgrade an officer incident", async () => {
    const { db, rows } = makeIncidentDb();
    const officer = {
      bookingId: "b-main",
      lodgeId: "lodge-a",
      cause: "OFFICER_OVERRIDE" as const,
      violation: UNCOVERED,
      override: { byMemberId: "officer-1", reason: "Officer decision" },
    };
    await openOrUpdateHostingCoverageIncident(officer, db);
    const system = await openOrUpdateHostingCoverageIncident(
      {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "SYSTEM_CHANGE",
        violation: UNCOVERED,
      },
      db,
    );
    expect(system.action).toBe("unchanged");
    expect(rows[0]).toMatchObject({
      cause: "OFFICER_OVERRIDE",
      overriddenByMemberId: "officer-1",
      overrideReason: "Officer decision",
    });
  });

  it("updates the open incident when the uncovered state moves", async () => {
    const { db, rows } = makeIncidentDb();
    await openOrUpdateHostingCoverageIncident(
      {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "SYSTEM_CHANGE",
        violation: UNCOVERED,
      },
      db,
    );
    const moved = await openOrUpdateHostingCoverageIncident(
      {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "SYSTEM_CHANGE",
        violation: violation([
          { guestRef: "kid", night: "2026-07-03" },
          { guestRef: "kid", night: "2026-07-04" },
        ]),
      },
      db,
    );
    expect(moved.action).toBe("updated");
    expect(rows).toHaveLength(1);
  });

  it("keeps an officer's override reason when a later system change updates the row", async () => {
    const { db, rows } = makeIncidentDb();
    await openOrUpdateHostingCoverageIncident(
      {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "OFFICER_OVERRIDE",
        violation: UNCOVERED,
        override: { byMemberId: "officer-1", reason: "Member rang to ask" },
      },
      db,
    );
    await openOrUpdateHostingCoverageIncident(
      {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "SYSTEM_CHANGE",
        violation: violation([{ guestRef: "kid", night: "2026-07-04" }]),
      },
      db,
    );
    expect(rows[0]).toMatchObject({
      overriddenByMemberId: "officer-1",
      overrideReason: "Member rang to ask",
      cause: "SYSTEM_CHANGE",
    });
  });

  it("refuses to record an override with an empty reason (§7)", async () => {
    const { db, rows } = makeIncidentDb();
    await expect(
      openOrUpdateHostingCoverageIncident(
        {
          bookingId: "b-main",
          lodgeId: "lodge-a",
          cause: "OFFICER_OVERRIDE",
          violation: UNCOVERED,
          override: { byMemberId: "officer-1", reason: "   " },
        },
        db,
      ),
    ).rejects.toThrow(/requires an explicit reason/);
    expect(rows).toEqual([]);
  });

  it("folds into the winner when a concurrent opener takes the unique index", async () => {
    // Two drains reconcile the same booking at once: both read no active row, both
    // insert, one loses on the partial unique index. The loser must fold in, not
    // surface a constraint violation, or the officer queue shows one booking twice.
    const { db, rows } = makeIncidentDb([], { failFirstCreate: true });
    const outcome = await openOrUpdateHostingCoverageIncident(
      {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "SYSTEM_CHANGE",
        violation: UNCOVERED,
      },
      db,
    );
    expect(outcome.action).toBe("updated");
    expect(rows.filter((row) => row.resolvedAt == null)).toHaveLength(1);
  });

  it("reports unchanged when the concurrent winner already recorded this state", async () => {
    const { db } = makeIncidentDb([
      {
        id: "incident-winner",
        bookingId: "b-main",
        resolvedAt: null,
        stateKey: hostingCoverageStateKey(UNCOVERED),
      },
    ]);
    const outcome = await openOrUpdateHostingCoverageIncident(
      {
        bookingId: "b-main",
        lodgeId: "lodge-a",
        cause: "SYSTEM_CHANGE",
        violation: UNCOVERED,
      },
      db,
    );
    expect(outcome.action).toBe("unchanged");
  });
});

describe("automatic resolution (#2576 §7, §16)", () => {
  it("closes every active incident once, and reports nothing the second time", async () => {
    const { db, audits } = makeIncidentDb([
      { id: "incident-1", bookingId: "b-main", resolvedAt: null, stateKey: "v1:a" },
    ]);
    expect(
      await resolveHostingCoverageIncidents(
        { bookingId: "b-main", resolution: "COVERAGE_RESTORED" },
        db,
      ),
    ).toBe(1);
    expect(
      await resolveHostingCoverageIncidents(
        { bookingId: "b-main", resolution: "COVERAGE_RESTORED" },
        db,
      ),
    ).toBe(0);
    // One resolution audit, because only one resolution happened.
    expect(audits).toHaveLength(1);
  });

  it("records WHICH of the four things happened rather than inferring it", async () => {
    for (const resolution of [
      "COVERAGE_RESTORED",
      "BOOKING_AMENDED",
      "EXCEPTION_APPROVED",
      "BOOKING_CANCELLED",
    ] as const) {
      const { db, rows } = makeIncidentDb([
        { id: "incident-1", bookingId: "b-main", resolvedAt: null, stateKey: "v1:a" },
      ]);
      await resolveHostingCoverageIncidents(
        { bookingId: "b-main", resolution },
        db,
      );
      expect(rows[0].resolution).toBe(resolution);
    }
  });
});

function makeNotificationDeliveryDb(
  overrides: Partial<Record<string, unknown>> = {},
) {
  const row: Record<string, any> = {
    id: "incident-1",
    bookingId: "booking-1",
    resolvedAt: null,
    stateKey: "v1:a",
    notifiedStateKey: null,
    ownerNotificationClaimStateKey: "v1:a",
    ownerNotificationClaimedAt: new Date("2026-07-01T11:59:00.000Z"),
    ownerNotificationClaimToken: "notification-current",
    evidence: { affectedNights: ["2026-07-03", "2026-07-04"] },
    booking: {
      id: "booking-1",
      memberId: "owner-1",
      lodgeId: "lodge-a",
      checkIn: new Date("2026-07-03T00:00:00.000Z"),
      checkOut: new Date("2026-07-05T00:00:00.000Z"),
      member: { firstName: "Owner", email: "owner@example.test" },
    },
    ...overrides,
  };
  const matches = (where: Record<string, any>) => {
    for (const field of [
      "id",
      "bookingId",
      "stateKey",
      "ownerNotificationClaimStateKey",
      "ownerNotificationClaimToken",
    ]) {
      if (where[field] !== undefined && row[field] !== where[field]) return false;
    }
    if (where.resolvedAt === null && row.resolvedAt != null) return false;
    if (
      where.ownerNotificationClaimedAt instanceof Date &&
      (!(row.ownerNotificationClaimedAt instanceof Date) ||
        row.ownerNotificationClaimedAt.getTime() !==
          where.ownerNotificationClaimedAt.getTime())
    ) {
      return false;
    }
    if (where.OR) {
      const notificationPending = where.OR.some((branch: any) => {
        if (branch.notifiedStateKey === null) return row.notifiedStateKey == null;
        if (branch.notifiedStateKey?.not !== undefined) {
          return (
            row.notifiedStateKey != null &&
            row.notifiedStateKey !== branch.notifiedStateKey.not
          );
        }
        return false;
      });
      if (!notificationPending) return false;
    }
    if (where.AND) {
      const claimAvailable = (where.AND[0]?.OR ?? []).some((branch: any) => {
        if (branch.ownerNotificationClaimStateKey === null) {
          return row.ownerNotificationClaimStateKey == null;
        }
        if (branch.ownerNotificationClaimStateKey?.not !== undefined) {
          return (
            row.ownerNotificationClaimStateKey != null &&
            row.ownerNotificationClaimStateKey !==
              branch.ownerNotificationClaimStateKey.not
          );
        }
        if (branch.ownerNotificationClaimedAt?.lt instanceof Date) {
          return (
            row.ownerNotificationClaimedAt instanceof Date &&
            row.ownerNotificationClaimedAt <
              branch.ownerNotificationClaimedAt.lt
          );
        }
        return false;
      });
      if (!claimAvailable) return false;
    }
    return true;
  };
  const updateMany = vi.fn(async ({ where, data }: any) => {
    if (!matches(where)) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  const findFirst = vi.fn(async ({ where }: any) =>
    matches(where) ? { evidence: row.evidence, booking: row.booking } : null,
  );
  return {
    row,
    updateMany,
    findFirst,
    db: { hostingCoverageIncident: { updateMany, findFirst } } as any,
  };
}

describe("the owner is told once per transition (#2576 §16)", () => {
  it("reports only an unresolved, exact-state, still-unnotified obligation as pending", async () => {
    const { db, row } = makeNotificationDeliveryDb();

    await expect(isHostingCoverageOwnerNotificationPending(
      { incidentId: "incident-1", stateKey: "v1:a" }, db,
    )).resolves.toBe(true);

    row.notifiedStateKey = "v1:a";
    await expect(isHostingCoverageOwnerNotificationPending(
      { incidentId: "incident-1", stateKey: "v1:a" }, db,
    )).resolves.toBe(false);

    row.notifiedStateKey = null;
    row.stateKey = "v1:b";
    await expect(isHostingCoverageOwnerNotificationPending(
      { incidentId: "incident-1", stateKey: "v1:a" }, db,
    )).resolves.toBe(false);

    row.stateKey = "v1:a";
    row.resolvedAt = new Date("2026-07-01T12:05:00.000Z");
    await expect(isHostingCoverageOwnerNotificationPending(
      { incidentId: "incident-1", stateKey: "v1:a" }, db,
    )).resolves.toBe(false);
  });

  it("leases a fresh notification once, then stamps it only after success", async () => {
    const { db, rows } = makeIncidentDb([
      {
        id: "incident-1",
        bookingId: "b-main",
        resolvedAt: null,
        stateKey: "v1:a",
        notifiedStateKey: null,
      },
    ]);
    const claim = await claimHostingCoverageOwnerNotification(
      { incidentId: "incident-1", stateKey: "v1:a" },
      db,
    );
    expect(claim).toMatchObject({
      incidentId: "incident-1",
      stateKey: "v1:a",
      claimToken: expect.any(String),
    });
    // The second drain of the same unchanged problem sends nothing.
    expect(
      await claimHostingCoverageOwnerNotification(
        { incidentId: "incident-1", stateKey: "v1:a" },
        db,
      ),
    ).toBeNull();
    expect(rows[0].notifiedStateKey).toBeNull();

    expect(
      await completeHostingCoverageOwnerNotification(
        claim!,
        db,
      ),
    ).toBe(true);
    expect(rows[0].notifiedStateKey).toBe("v1:a");
    expect(rows[0].ownerNotificationClaimStateKey).toBeNull();
    expect(
      await claimHostingCoverageOwnerNotification(
        { incidentId: "incident-1", stateKey: "v1:a" },
        db,
      ),
    ).toBeNull();
  });

  it("releases a failed delivery so the unchanged state is retryable", async () => {
    const { db } = makeIncidentDb([
      {
        id: "incident-1",
        bookingId: "b-main",
        resolvedAt: null,
        stateKey: "v1:a",
        notifiedStateKey: null,
      },
    ]);
    const claim = await claimHostingCoverageOwnerNotification(
      { incidentId: "incident-1", stateKey: "v1:a" },
      db,
    );
    expect(claim).not.toBeNull();
    expect(await releaseHostingCoverageOwnerNotification(claim!, db)).toBe(true);
    expect(
      await claimHostingCoverageOwnerNotification(
        { incidentId: "incident-1", stateKey: "v1:a" },
        db,
      ),
    ).not.toBeNull();
  });

  it("notifies again when the uncovered state materially changes", async () => {
    const { db } = makeIncidentDb([
      {
        id: "incident-1",
        bookingId: "b-main",
        resolvedAt: null,
        stateKey: "v1:b",
        notifiedStateKey: "v1:a",
      },
    ]);
    expect(
      await claimHostingCoverageOwnerNotification(
        { incidentId: "incident-1", stateKey: "v1:b" },
        db,
      ),
    ).not.toBeNull();
  });

  it("does not notify about an incident that has been resolved underneath it", async () => {
    const { db } = makeIncidentDb([
      {
        id: "incident-1",
        bookingId: "b-main",
        resolvedAt: new Date(),
        stateKey: "v1:a",
        notifiedStateKey: null,
      },
    ]);
    expect(
      await claimHostingCoverageOwnerNotification(
        { incidentId: "incident-1", stateKey: "v1:a" },
        db,
      ),
    ).toBeNull();
  });

  it("does not let an expired claimant complete or release its successor's lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    try {
      const { db, rows } = makeIncidentDb([
        {
          id: "incident-1",
          bookingId: "b-main",
          resolvedAt: null,
          stateKey: "v1:a",
          notifiedStateKey: null,
        },
      ]);
      const stale = await claimHostingCoverageOwnerNotification(
        { incidentId: "incident-1", stateKey: "v1:a" },
        db,
      );
      expect(stale).not.toBeNull();

      vi.advanceTimersByTime(16 * 60 * 1000);
      const current = await claimHostingCoverageOwnerNotification(
        { incidentId: "incident-1", stateKey: "v1:a" },
        db,
      );
      expect(current).not.toBeNull();
      expect(current!.claimToken).not.toBe(stale!.claimToken);

      expect(await releaseHostingCoverageOwnerNotification(stale!, db)).toBe(false);
      expect(rows[0].ownerNotificationClaimToken).toBe(current!.claimToken);
      expect(await completeHostingCoverageOwnerNotification(stale!, db)).toBe(false);
      expect(await completeHostingCoverageOwnerNotification(current!, db)).toBe(true);
      expect(rows[0].notifiedStateKey).toBe("v1:a");
    } finally {
      vi.useRealTimers();
    }
  });

  it("freezes incident evidence only while the exact incident, state, and token are current", async () => {
    const now = new Date("2026-07-01T12:00:00.000Z");
    const { db, row, updateMany, findFirst } = makeNotificationDeliveryDb();
    const claim = {
      bookingId: "booking-1",
      incidentId: "incident-1",
      stateKey: "v1:a",
      claimToken: "notification-current",
    };

    await expect(
      loadHostingCoverageOwnerNotificationDelivery(claim, db, now),
    ).resolves.toMatchObject({
      bookingId: "booking-1",
      recipientMemberId: "owner-1",
      uncoveredNights: "2026-07-03, 2026-07-04",
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        bookingId: "booking-1",
        resolvedAt: null,
        stateKey: "v1:a",
        ownerNotificationClaimStateKey: "v1:a",
        ownerNotificationClaimToken: "notification-current",
        OR: [
          { notifiedStateKey: null },
          { notifiedStateKey: { not: "v1:a" } },
        ],
      },
      data: { ownerNotificationClaimedAt: now },
    });
    expect(row.ownerNotificationClaimedAt).toEqual(now);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerNotificationClaimedAt: now,
          ownerNotificationClaimToken: "notification-current",
          resolvedAt: null,
        }),
      }),
    );
    expect(JSON.stringify(findFirst.mock.calls[0][0].select)).not.toContain(
      "adultMemberHostingReview",
    );

    row.ownerNotificationClaimToken = "notification-successor";
    await expect(
      loadHostingCoverageOwnerNotificationDelivery(claim, db, now),
    ).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(1);

    row.ownerNotificationClaimToken = "notification-current";
    row.stateKey = "v1:b";
    await expect(
      loadHostingCoverageOwnerNotificationDelivery(claim, db, now),
    ).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(1);

    row.stateKey = "v1:a";
    row.resolvedAt = new Date();
    await expect(
      loadHostingCoverageOwnerNotificationDelivery(claim, db, now),
    ).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it.each<[string, number]>([
    ["fresh", HOSTING_COVERAGE_OWNER_NOTIFICATION_LEASE_MS - 1],
    ["at the exact expiry boundary", HOSTING_COVERAGE_OWNER_NOTIFICATION_LEASE_MS],
    ["expired but unreclaimed", HOSTING_COVERAGE_OWNER_NOTIFICATION_LEASE_MS + 1],
  ])("renews and delivers a %s exact claim just before transport", async (_label, ageMs) => {
    const now = new Date("2026-07-01T12:00:00.000Z");
    const claimedAt = new Date(now.getTime() - ageMs);
    const { db, row, updateMany, findFirst } = makeNotificationDeliveryDb({
      ownerNotificationClaimedAt: claimedAt,
      evidence: { affectedNights: ["2026-07-03"] },
    });

    const result = await loadHostingCoverageOwnerNotificationDelivery(
      {
        bookingId: "booking-1",
        incidentId: "incident-1",
        stateKey: "v1:a",
        claimToken: "notification-current",
      },
      db,
      now,
    );

    expect(result).toMatchObject({ uncoveredNights: "2026-07-03" });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-1",
          bookingId: "booking-1",
          resolvedAt: null,
          stateKey: "v1:a",
          ownerNotificationClaimStateKey: "v1:a",
          ownerNotificationClaimToken: "notification-current",
        }),
        data: { ownerNotificationClaimedAt: now },
      }),
    );
    expect(row.ownerNotificationClaimedAt).toEqual(now);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerNotificationClaimedAt: now,
        }),
      }),
    );
  });

  it("serializes expired exact renewal against successor takeover so only one token wins", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-01T12:00:00.000Z");
    vi.setSystemTime(now);
    const expiredAt = new Date(
      now.getTime() - HOSTING_COVERAGE_OWNER_NOTIFICATION_LEASE_MS - 1,
    );
    const oldClaim = {
      bookingId: "booking-1",
      incidentId: "incident-1",
      stateKey: "v1:a",
      claimToken: "notification-current",
    };
    try {
      // Old exact token reaches the row first: it renews, so takeover no longer
      // sees an expired timestamp.
      const oldWins = makeNotificationDeliveryDb({
        ownerNotificationClaimedAt: expiredAt,
      });
      await expect(
        loadHostingCoverageOwnerNotificationDelivery(oldClaim, oldWins.db, now),
      ).resolves.not.toBeNull();
      await expect(
        claimHostingCoverageOwnerNotification(
          { incidentId: "incident-1", stateKey: "v1:a" },
          oldWins.db,
        ),
      ).resolves.toBeNull();
      expect(oldWins.row.ownerNotificationClaimToken).toBe(
        "notification-current",
      );

      // Successor reaches the expired row first: its new token replaces the old
      // one, so the old token loses renewal and cannot reach the payload read.
      const successorWins = makeNotificationDeliveryDb({
        ownerNotificationClaimedAt: expiredAt,
      });
      const successor = await claimHostingCoverageOwnerNotification(
        { incidentId: "incident-1", stateKey: "v1:a" },
        successorWins.db,
      );
      expect(successor).toMatchObject({
        incidentId: "incident-1",
        stateKey: "v1:a",
        claimToken: expect.any(String),
      });
      expect(successor!.claimToken).not.toBe("notification-current");
      await expect(
        loadHostingCoverageOwnerNotificationDelivery(
          oldClaim,
          successorWins.db,
          now,
        ),
      ).resolves.toBeNull();
      expect(successorWins.findFirst).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** An in-memory re-evaluation queue. */
function makeQueueDb(seed: Array<Record<string, unknown>> = []) {
  const rows: Array<Record<string, unknown>> = seed.map((row) => ({ ...row }));
  const db = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    member: {
      findMany: vi.fn().mockResolvedValue([{ id: "owner-1" }]),
    },
    booking: {
      findMany: vi.fn().mockResolvedValue([
        { id: "source-1", memberId: "owner-1", lodgeId: "lodge-a" },
      ]),
    },
    hostingCoverageReevaluation: {
      create: vi.fn(async ({ data }: any) => {
        const created = {
          id: `queue-${rows.length + 1}`,
          attempts: 0,
          processedAt: null,
          claimToken: null,
          claimExpiresAt: null,
          enqueuedAt: new Date(1_700_000_000_000 + rows.length),
          ...data,
        };
        rows.push(created);
        return { id: created.id };
      }),
      findMany: vi.fn(async ({ where, take }: any) =>
        rows
          .filter(
            (row) =>
              (where.processedAt !== null || row.processedAt == null) &&
              (where.id?.notIn === undefined ||
                !where.id.notIn.includes(row.id)) &&
              (where.attempts?.lt === undefined ||
                (row.attempts as number) < where.attempts.lt) &&
              (where.OR === undefined ||
                where.OR.some((branch: any) => {
                  if (branch.claimToken === null) return row.claimToken == null;
                  if (branch.claimExpiresAt?.lt instanceof Date) {
                    return (
                      row.claimExpiresAt instanceof Date &&
                      row.claimExpiresAt < branch.claimExpiresAt.lt
                    );
                  }
                  return false;
                })),
          )
          .sort(
            (a, b) =>
              (a.enqueuedAt as Date).getTime() - (b.enqueuedAt as Date).getTime(),
          )
          .slice(0, take)
          // COPIES, like a real read. Handing out the live row would let the
          // guarded claim's own increment be visible to the caller's `attempts + 1`
          // and double-count it — an artefact of the fake, not of the queue.
          .map((row) => ({ ...row })),
      ),
      findFirst: vi.fn(async ({ where }: any) => {
        const row = rows.find(
          (candidate) =>
            candidate.id === where.id &&
            candidate.claimToken === where.claimToken &&
            (where.processedAt !== null || candidate.processedAt == null),
        );
        return row ? { ...row } : null;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const matched = rows.filter((row) => {
          if (row.id !== where.id) return false;
          if (where.processedAt === null && row.processedAt != null) return false;
          if (where.attempts !== undefined && row.attempts !== where.attempts) {
            return false;
          }
          if (
            where.claimToken !== undefined &&
            row.claimToken !== where.claimToken
          ) {
            return false;
          }
          if (
            where.OR !== undefined &&
            !where.OR.some((branch: any) => {
              if (branch.claimToken === null) return row.claimToken == null;
              if (branch.claimExpiresAt?.lt instanceof Date) {
                return (
                  row.claimExpiresAt instanceof Date &&
                  row.claimExpiresAt < branch.claimExpiresAt.lt
                );
              }
              return false;
            })
          ) {
            return false;
          }
          return true;
        });
        for (const row of matched) {
          for (const [key, value] of Object.entries(data)) {
            if (value && typeof value === "object") {
              const operation = value as {
                increment?: number;
                decrement?: number;
              };
              if (operation.increment !== undefined) {
                row[key] = (row[key] as number) + operation.increment;
              } else if (operation.decrement !== undefined) {
                row[key] = (row[key] as number) - operation.decrement;
              } else {
                row[key] = value;
              }
            } else {
              row[key] = value;
            }
          }
        }
        return { count: matched.length };
      }),
    },
  } as any;
  return { db, rows };
}

describe("the bounded re-evaluation queue (#2576 §8, §10)", () => {
  it("stores a sorted, de-duplicated night list and records nothing for no nights", async () => {
    const { db, rows } = makeQueueDb();
    const proof = await acquireHostingCoverageQueueParticipantProof(
      {
        sources: [
          {
            bookingId: "source-1",
            ownerMemberId: "owner-1",
            lodgeId: "lodge-a",
          },
        ],
      },
      db,
    );
    expect(
      await enqueueHostingCoverageReevaluation(
        {
          memberId: "owner-1",
          lodgeId: "lodge-a",
          nights: ["2026-07-04", "2026-07-03", "2026-07-04"],
          cause: "SYSTEM_CHANGE",
          sourceBookingId: "source-1",
        },
        proof,
        db,
      ),
    ).toBe("queue-1");
    expect(rows[0].nights).toEqual(["2026-07-03", "2026-07-04"]);

    expect(
      await enqueueHostingCoverageReevaluation(
        {
          memberId: "owner-1",
          lodgeId: "lodge-a",
          nights: [],
          cause: "SYSTEM_CHANGE",
          sourceBookingId: "source-1",
        },
        proof,
        db,
      ),
    ).toBeNull();
    expect(rows).toHaveLength(1);
  });

  it("truncates an over-long officer reason rather than failing the change", async () => {
    const { db, rows } = makeQueueDb();
    const proof = await acquireHostingCoverageQueueParticipantProof(
      {
        sources: [
          {
            bookingId: "source-1",
            ownerMemberId: "owner-1",
            lodgeId: "lodge-a",
          },
        ],
      },
      db,
    );
    await enqueueHostingCoverageReevaluation(
      {
        memberId: "owner-1",
        lodgeId: "lodge-a",
        nights: ["2026-07-03"],
        cause: "OFFICER_OVERRIDE",
        reason: "x".repeat(900),
        sourceBookingId: "source-1",
      },
      proof,
      db,
    );
    expect((rows[0].reason as string).length).toBe(500);
  });

  it("re-reads the full payload only through the exact live claim", async () => {
    const { db } = makeQueueDb([{
      id: "queue-1",
      memberId: "owner-master",
      lodgeId: "lodge-b",
      nights: ["2026-07-04", "bad", "2026-07-03", "2026-07-04"],
      cause: "OFFICER_OVERRIDE",
      sourceBookingId: "source-after",
      actorMemberId: "actor-master",
      reason: "authoritative reason",
      attempts: 2,
      processedAt: null,
      claimToken: "claim-current",
      claimExpiresAt: new Date("2026-07-01T00:15:00.000Z"),
      enqueuedAt: new Date("2026-07-01T00:00:00.000Z"),
    }]);

    await expect(loadClaimedHostingCoverageReevaluation(
      { id: "queue-1", claimToken: "claim-current" },
      db,
    )).resolves.toMatchObject({
      memberId: "owner-master",
      lodgeId: "lodge-b",
      nights: ["2026-07-03", "2026-07-04"],
      cause: "OFFICER_OVERRIDE",
      sourceBookingId: "source-after",
      actorMemberId: "actor-master",
      reason: "authoritative reason",
      claimToken: "claim-current",
    });
    expect(db.hostingCoverageReevaluation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "queue-1", claimToken: "claim-current", processedAt: null },
      }),
    );
    await expect(loadClaimedHostingCoverageReevaluation(
      { id: "queue-1", claimToken: "claim-replaced" },
      db,
    )).resolves.toBeNull();
  });

  it("counts an attempt at claim time, so a poison item retires", async () => {
    const { db, rows } = makeQueueDb([
      {
        id: "queue-1",
        memberId: "owner-1",
        lodgeId: "lodge-a",
        nights: ["2026-07-03"],
        cause: "SYSTEM_CHANGE",
        sourceBookingId: null,
        actorMemberId: null,
        reason: null,
        attempts: 0,
        processedAt: null,
        claimToken: null,
        claimExpiresAt: null,
        enqueuedAt: new Date(1_700_000_000_000),
      },
    ]);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claimed = await claimHostingCoverageReevaluations({ limit: 5 }, db);
      expect(claimed.map((item) => item.attempts)).toEqual([attempt]);
      expect(
        await failHostingCoverageReevaluation(
          claimed[0],
          `attempt ${attempt} failed`,
          db,
        ),
      ).toBe(true);
    }
    // Incremented at claim rather than on failure, so a process that dies mid-item
    // still counts up. After maxAttempts the item is left alone.
    expect(rows[0].attempts).toBe(5);
    expect(await claimHostingCoverageReevaluations({ limit: 5 }, db)).toEqual([]);
  });

  it("gives an item to exactly one of two concurrent drains", async () => {
    const { db, rows } = makeQueueDb([
      {
        id: "queue-1",
        memberId: "owner-1",
        lodgeId: "lodge-a",
        nights: ["2026-07-03"],
        cause: "SYSTEM_CHANGE",
        sourceBookingId: null,
        actorMemberId: null,
        reason: null,
        attempts: 0,
        processedAt: null,
        claimToken: null,
        claimExpiresAt: null,
        enqueuedAt: new Date(1_700_000_000_000),
      },
    ]);
    // The first drain records both an incremented attempt and an opaque lease.
    const a = await claimHostingCoverageReevaluations({ limit: 5 }, db);
    expect(a).toHaveLength(1);
    expect(a[0].attempts).toBe(1);
    // A staggered drain starts after the increment but before completion. The
    // unexpired lease excludes the item before `take`, so attempts cannot burn
    // merely because another worker is still processing it.
    expect(await claimHostingCoverageReevaluations({ limit: 5 }, db)).toEqual([]);
    expect(rows[0].attempts).toBe(1);
  });

  it("excludes rows already seen by the current drain", async () => {
    const { db, rows } = makeQueueDb([
      {
        id: "queue-1",
        memberId: "owner-1",
        lodgeId: "lodge-a",
        nights: ["2026-07-03"],
        cause: "SYSTEM_CHANGE",
        sourceBookingId: null,
        actorMemberId: null,
        reason: null,
        attempts: 0,
        processedAt: null,
        claimToken: null,
        claimExpiresAt: null,
        enqueuedAt: new Date(1_700_000_000_000),
      },
      {
        id: "queue-2",
        memberId: "owner-1",
        lodgeId: "lodge-a",
        nights: ["2026-07-04"],
        cause: "SYSTEM_CHANGE",
        sourceBookingId: null,
        actorMemberId: null,
        reason: null,
        attempts: 0,
        processedAt: null,
        claimToken: null,
        claimExpiresAt: null,
        enqueuedAt: new Date(1_700_000_000_001),
      },
    ]);

    const claimed = await claimHostingCoverageReevaluations(
      { limit: 1, excludeIds: ["queue-1"] },
      db,
    );

    expect(claimed.map((item) => item.id)).toEqual(["queue-2"]);
    expect(rows[0].attempts).toBe(0);
    expect(rows[1].attempts).toBe(1);
  });

  it("retries a crashed claim only after expiry and fences stale completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    try {
      const { db, rows } = makeQueueDb([
        {
          id: "queue-1",
          memberId: "owner-1",
          lodgeId: "lodge-a",
          nights: ["2026-07-03"],
          cause: "SYSTEM_CHANGE",
          sourceBookingId: null,
          actorMemberId: null,
          reason: null,
          attempts: 0,
          processedAt: null,
          claimToken: null,
          claimExpiresAt: null,
          enqueuedAt: new Date(1_700_000_000_000),
        },
      ]);
      const [stale] = await claimHostingCoverageReevaluations({ limit: 5 }, db);
      expect(await claimHostingCoverageReevaluations({ limit: 5 }, db)).toEqual([]);

      vi.advanceTimersByTime(16 * 60 * 1000);
      const [current] = await claimHostingCoverageReevaluations({ limit: 5 }, db);
      expect(current.claimToken).not.toBe(stale.claimToken);
      expect(current.attempts).toBe(2);

      expect(
        await failHostingCoverageReevaluation(stale, "stale failure", db),
      ).toBe(false);
      expect(rows[0].lastError).toBeUndefined();
      expect(rows[0].claimToken).toBe(current.claimToken);
      expect(await completeHostingCoverageReevaluation(stale, db)).toBe(false);
      expect(rows[0].processedAt).toBeNull();
      expect(rows[0].claimToken).toBe(current.claimToken);
      expect(await completeHostingCoverageReevaluation(current, db)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews only the exact queue token and parks without consuming its attempt", async () => {
    const { db, rows } = makeQueueDb([{
      id: "queue-1",
      memberId: "owner-1",
      lodgeId: "lodge-a",
      nights: ["2026-07-03"],
      cause: "SYSTEM_CHANGE",
      sourceBookingId: null,
      actorMemberId: null,
      reason: null,
      attempts: 5,
      processedAt: null,
      claimToken: "claim-current",
      claimExpiresAt: new Date("2026-07-01T00:01:00.000Z"),
      enqueuedAt: new Date("2026-07-01T00:00:00.000Z"),
    }]);
    const now = new Date("2026-07-01T00:02:00.000Z");

    await expect(renewHostingCoverageReevaluationClaim(
      { id: "queue-1", claimToken: "claim-replaced" }, db, now,
    )).resolves.toBe(false);
    await expect(renewHostingCoverageReevaluationClaim(
      { id: "queue-1", claimToken: "claim-current" }, db, now,
    )).resolves.toBe(true);
    expect(rows[0].claimExpiresAt).toEqual(new Date("2026-07-01T00:17:00.000Z"));

    await expect(deferHostingCoverageReevaluation(
      { id: "queue-1", claimToken: "claim-current" }, db,
    )).resolves.toBe(true);
    expect(rows[0]).toMatchObject({
      attempts: 4,
      claimToken: "claim-current",
      processedAt: null,
    });
    expect(rows[0].claimExpiresAt).toEqual(new Date("2026-07-01T00:17:00.000Z"));
  });

  it("releases policy contention for an immediate successor without consuming an attempt", async () => {
    const { db, rows } = makeQueueDb([{
      id: "queue-1",
      memberId: "owner-1",
      lodgeId: "lodge-a",
      nights: ["2026-07-03"],
      cause: "SYSTEM_CHANGE",
      sourceBookingId: null,
      actorMemberId: null,
      reason: null,
      attempts: 1,
      processedAt: null,
      claimToken: "claim-contended",
      claimExpiresAt: new Date("2026-07-01T00:15:00.000Z"),
      enqueuedAt: new Date("2026-07-01T00:00:00.000Z"),
    }]);

    await expect(
      releaseHostingCoverageReevaluationContention(
        { id: "queue-1", claimToken: "claim-replaced" },
        db,
      ),
    ).resolves.toBe(false);
    await expect(
      releaseHostingCoverageReevaluationContention(
        { id: "queue-1", claimToken: "claim-contended" },
        db,
      ),
    ).resolves.toBe(true);
    expect(rows[0]).toMatchObject({
      attempts: 0,
      claimToken: null,
      claimExpiresAt: null,
      processedAt: null,
    });

    const [successor] = await claimHostingCoverageReevaluations(
      { limit: 1, maxAttempts: 1 },
      db,
    );
    expect(successor).toMatchObject({ id: "queue-1", attempts: 1 });
    expect(successor.claimToken).not.toBe("claim-contended");
  });

  it("drops a night list that is not a list of dates rather than widening the bound", async () => {
    const { db } = makeQueueDb([
      {
        id: "queue-1",
        memberId: "owner-1",
        lodgeId: "lodge-a",
        nights: "everything at the lodge",
        cause: "SYSTEM_CHANGE",
        sourceBookingId: null,
        actorMemberId: null,
        reason: null,
        attempts: 0,
        processedAt: null,
        claimToken: null,
        claimExpiresAt: null,
        enqueuedAt: new Date(1_700_000_000_000),
      },
    ]);
    const [item] = await claimHostingCoverageReevaluations({ limit: 5 }, db);
    // A malformed row is a no-op item, never a lodge-wide sweep (§10).
    expect(item.nights).toEqual([]);
  });

  it("completes and fails idempotently", async () => {
    const { db, rows } = makeQueueDb([
      {
        id: "queue-1",
        attempts: 1,
        processedAt: null,
        enqueuedAt: new Date(1_700_000_000_000),
        lastError: null,
      },
    ]);
    const claim = { id: "queue-1", claimToken: "claim-current" };
    rows[0].claimToken = claim.claimToken;
    rows[0].claimExpiresAt = new Date(Date.now() + 60_000);
    expect(
      await failHostingCoverageReevaluation(claim, "x".repeat(1200), db),
    ).toBe(true);
    expect((rows[0].lastError as string).length).toBe(1000);
    expect(rows[0].processedAt).toBeNull();

    const nextClaim = { id: "queue-1", claimToken: "claim-next" };
    rows[0].claimToken = nextClaim.claimToken;
    rows[0].claimExpiresAt = new Date(Date.now() + 60_000);
    expect(await completeHostingCoverageReevaluation(nextClaim, db)).toBe(true);
    expect(rows[0].processedAt).not.toBeNull();
    expect(rows[0].lastError).toBeNull();
    const processedAt = rows[0].processedAt;
    expect(await completeHostingCoverageReevaluation(nextClaim, db)).toBe(false);
    expect(rows[0].processedAt).toBe(processedAt);
  });
});
