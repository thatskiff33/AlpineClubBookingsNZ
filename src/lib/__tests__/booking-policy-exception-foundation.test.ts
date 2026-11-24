import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HARD_STOP_BOOKING_FAILURE_CODES,
  POLICY_EXCEPTION_REASON_CODES,
  aggregatePolicyExceptionViolations,
  isHardStopBookingFailureCode,
  isPolicyExceptionReasonCode,
  type MinimumStayPolicyExceptionViolation,
} from "@/lib/booking-policy-exceptions";
import {
  MINIMUM_STAY_POLICY_SET_LOCK_KEY,
  lockMinimumStayPolicySet,
} from "@/lib/minimum-stay-policy-set";
import { minimumStayCreateBodySchema } from "@/lib/admin-bookings-schemas/setup";
import { getMinimumStayViolations } from "@/lib/policies/minimum-stay";

const MIGRATION =
  "20260802130000_add_booking_policy_exception_foundation";

function repoFile(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function violation(
  policyId: string,
  capacityMode: "HOLD" | "NO_HOLD",
): MinimumStayPolicyExceptionViolation {
  return {
    reasonCode: "MINIMUM_STAY",
    policyId,
    policyVersion: 3,
    policyName: `Policy ${policyId}`,
    resolvedScope: {
      kind: "LODGE",
      lodgeId: "lodge-1",
      effectiveLodgeId: "lodge-1",
    },
    affectedNights: ["2026-07-04"],
    exceptionEligible: true,
    capacityMode,
    message: "A minimum-stay exception is required.",
    triggerDay: "Saturday",
    minimumNights: 2,
    actualNights: 1,
    requirements: {
      kind: "MINIMUM_STAY",
      minimumNights: 2,
      actualNights: 1,
      triggerDays: [6],
    },
  };
}

describe("booking-policy exception registry (#2363)", () => {
  it("is a closed three-reason soft-policy allowlist disjoint from hard stops", () => {
    // #2543 added the third: a party the club is repricing for unpaid
    // subscriptions must carry a paid-up adult member, and that refusal is
    // exception-eligible so a Booking Officer can allow it through. It is
    // deliberately NOT a hard stop — the assertions below are what enforce that
    // the two families stay disjoint.
    expect(POLICY_EXCEPTION_REASON_CODES).toEqual([
      "MINIMUM_STAY",
      "ADULT_MEMBER_HOSTING_REQUIRED",
      "PAID_UP_ADULT_MEMBER_REQUIRED",
    ]);
    expect(new Set(POLICY_EXCEPTION_REASON_CODES).size).toBe(3);
    for (const code of HARD_STOP_BOOKING_FAILURE_CODES) {
      expect(isHardStopBookingFailureCode(code)).toBe(true);
      expect(isPolicyExceptionReasonCode(code)).toBe(false);
    }
    expect(isPolicyExceptionReasonCode("CAPACITY_EXCEEDED")).toBe(false);
    expect(isPolicyExceptionReasonCode("MINIMUM_STAY")).toBe(true);
    expect(isPolicyExceptionReasonCode("PAID_UP_ADULT_MEMBER_REQUIRED")).toBe(
      true,
    );
    // The subscription hard stops keep their meaning: HARD_BLOCK still refuses
    // outright and may never enter review, which is what makes #2543's new code a
    // genuinely separate regime rather than a softening of those two.
    expect(isPolicyExceptionReasonCode("SUBSCRIPTION_REQUIRED")).toBe(false);
    expect(isPolicyExceptionReasonCode("GUEST_SUBSCRIPTION_REQUIRED")).toBe(
      false,
    );
    expect(HARD_STOP_BOOKING_FAILURE_CODES).toEqual(
      expect.arrayContaining([
        "CAPACITY_EXCEEDED",
        "SUBSCRIPTION_REQUIRED",
        "GUEST_SUBSCRIPTION_REQUIRED",
        "BOOKING_MEMBER_NIGHT_CONFLICT",
      ]),
    );
  });

  it.each([
    "CAPACITY_EXCEEDED",
    "SUBSCRIPTION_REQUIRED",
    "GUEST_SUBSCRIPTION_REQUIRED",
    "BOOKING_MEMBER_NIGHT_CONFLICT",
  ] as const)("refuses to aggregate the hard-stop code %s", (reasonCode) => {
    const corrupted = { ...violation("policy-1", "NO_HOLD"), reasonCode };

    expect(() =>
      aggregatePolicyExceptionViolations([
        corrupted as unknown as MinimumStayPolicyExceptionViolation,
      ]),
    ).toThrow(
      `Non-allowlisted booking failure cannot enter policy exception review: ${reasonCode}`,
    );
  });

  it("freezes exact date-only nights, policy identity/version and scope", () => {
    const result = getMinimumStayViolations(
      new Date("2026-07-03T00:00:00.000Z"),
      new Date("2026-07-05T00:00:00.000Z"),
      [
        {
          id: "policy-9",
          version: 7,
          name: "Friday and Saturday",
          startDate: new Date("2026-06-01T00:00:00.000Z"),
          endDate: new Date("2026-09-30T00:00:00.000Z"),
          triggerDays: [6, 5, 6],
          minimumNights: 3,
          lodgeId: null,
          capacityMode: "NO_HOLD",
        },
      ],
      "lodge-2",
    );

    expect(result).toEqual([
      expect.objectContaining({
        reasonCode: "MINIMUM_STAY",
        policyId: "policy-9",
        policyVersion: 7,
        resolvedScope: {
          kind: "CLUB_WIDE",
          lodgeId: null,
          effectiveLodgeId: "lodge-2",
        },
        affectedNights: ["2026-07-03", "2026-07-04"],
        capacityMode: "NO_HOLD",
        exceptionEligible: true,
        requirements: {
          kind: "MINIMUM_STAY",
          minimumNights: 3,
          actualNights: 2,
          triggerDays: [5, 6],
        },
      }),
    ]);
  });

  it("orders deterministically and applies HOLD-wins aggregation", () => {
    expect(
      aggregatePolicyExceptionViolations([
        violation("z-policy", "NO_HOLD"),
        violation("a-policy", "HOLD"),
      ]),
    ).toEqual({
      capacityMode: "HOLD",
      violations: [violation("a-policy", "HOLD"), violation("z-policy", "NO_HOLD")],
    });
    expect(aggregatePolicyExceptionViolations([])).toEqual({
      capacityMode: null,
      violations: [],
    });
  });
});

describe("minimum-stay policy write contract (#2363)", () => {
  it("uses DB defaults only to bridge the draining old colour", () => {
    const migration = repoFile(
      `prisma/migrations/${MIGRATION}/migration.sql`,
    );
    const ledger = repoFile("docs/BLUE_GREEN_MIGRATION_SAFETY.tsv");
    const row = ledger
      .split(/\r?\n/)
      .find((line) => line.startsWith(`${MIGRATION}\t`));

    expect(migration).toContain(
      'ADD COLUMN "capacityMode" "PolicyExceptionCapacityMode" NOT NULL DEFAULT \'HOLD\'',
    );
    expect(migration).toContain(
      'ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1',
    );
    expect(row).toContain("draining pre-#2363 colour");
    expect(row).toContain("new runtime requires capacityMode");
    expect(row).toContain("never relies on the DB default");
    expect(row).toContain("BEFORE STATEMENT INSERT/UPDATE/DELETE trigger");
    expect(row).toContain("advisory-before-row order");
    expect(row).toContain("old colour");
    expect(row).toContain("not double-incremented");
  });

  it("requires new-runtime creates to submit capacityMode explicitly", () => {
    // The create schema lives beside the AI app catalogue's copy of it
    // (ALP-719); the route parses with it, so its refusal is the route's.
    const create = {
      name: "Peak weekends",
      startDate: "2026-07-01",
      endDate: "2026-09-30",
      triggerDays: [5],
      minimumNights: 2,
    };
    expect(minimumStayCreateBodySchema.safeParse(create).success).toBe(false);
    expect(minimumStayCreateBodySchema.safeParse({ ...create, capacityMode: "HOLD" }).success).toBe(true);
    const route = repoFile(
      "src/app/api/admin/booking-policies/minimum-stay/route.ts",
    );
    expect(route).toContain("minimumStayCreateBodySchema.parse(");
    expect(route).toContain("capacityMode: data.capacityMode");
    expect(route).not.toContain("capacityMode: data.capacityMode ??");
  });

  it("acquires the one shared policy-set lock before reads and writes", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const tx = { $executeRaw: executeRaw };

    await lockMinimumStayPolicySet(
      tx as unknown as Parameters<typeof lockMinimumStayPolicySet>[0],
    );

    expect(MINIMUM_STAY_POLICY_SET_LOCK_KEY).toBe("minimum-stay-policy-set");
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(executeRaw.mock.calls[0][1]).toBe("minimum-stay-policy-set");
  });

  it("puts old-colour writes behind the same DB lock and revision protocol", () => {
    const migration = repoFile(
      `prisma/migrations/${MIGRATION}/migration.sql`,
    );

    expect(migration).toContain(
      'CREATE TRIGGER "MinimumStayPolicy_lock_set"',
    );
    expect(migration).toContain("BEFORE INSERT OR UPDATE OR DELETE");
    expect(migration).toContain("FOR EACH STATEMENT");
    expect(migration).toContain(
      "PERFORM pg_advisory_xact_lock(hashtext('minimum-stay-policy-set'))",
    );
    expect(migration).toContain(
      'CREATE TRIGGER "MinimumStayPolicy_version"',
    );
    expect(migration).toContain("BEFORE INSERT OR UPDATE");
    expect(migration).toContain("FOR EACH ROW");
    expect(migration).toContain(
      'NEW."version" := OLD."version" + 1',
    );
    expect(migration).toContain(
      'NEW."version" <> OLD."version" + 1',
    );
    expect(migration).toContain(
      'NEW."version" := OLD."version";',
    );
  });

  it("wires the isolated-schema trigger proof into hosted disposable PostgreSQL", () => {
    const triggerTest = repoFile(
      "src/lib/__tests__/minimum-stay-policy-trigger.realdb.test.ts",
    );
    const hostedHarness = repoFile(
      "src/lib/__tests__/concurrency-lock-races.realdb.test.ts",
    );

    expect(hostedHarness).toContain(
      'import "./minimum-stay-policy-trigger.realdb.test";',
    );
    expect(triggerTest).toContain('process.env.CI === "true"');
    expect(triggerTest).toContain(
      'process.env.RUN_CONCURRENCY_RACE_TESTS === "1"',
    );
    expect(triggerTest).toContain("CONCURRENCY_RACE_DATABASE_URL");
    expect(triggerTest).toContain("concurrency_race_1881");
    expect(triggerTest).toContain("CREATE SCHEMA");
    expect(triggerTest).toContain("DROP SCHEMA IF EXISTS");
  });
});
