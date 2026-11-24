import type { MembershipTypeSubscriptionBehavior } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { matchesWhere } from "@/lib/__tests__/support/prisma-where";

// #5190: once a club chooses its liability rule, a saved NOT_REQUIRED row
// exempts nobody, so `clearStaleNotRequiredRows` flips the untouched ones whose
// member now owes. It must never touch real billing state — above all a
// NO_INVOICE fee's active coverage claim, which leaves the row NOT_REQUIRED.

const behaviors = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/membership-type-policy", () => ({
  resolveMembershipTypePoliciesForMembers: vi.fn(
    async (_db: unknown, params: { memberIds: string[] }) =>
      new Map(
        params.memberIds
          .filter((id) => behaviors.has(id))
          .map((id) => [id, { subscriptionBehavior: behaviors.get(id) }]),
      ),
  ),
}));

import {
  CLEARED_ROWS_AUDIT_MEMBER_ID_LIMIT,
  clearStaleNotRequiredRows,
  clearedRowsAuditMetadata,
  findStaleNotRequiredRows,
} from "@/lib/member-subscription-defaults";

const SEASON = 2026;
const NOTHING_CLEARED = { clearedCount: 0, clearedMemberIds: [] };

type Row = {
  memberId: string;
  seasonYear: number;
  status: string;
  xeroInvoiceId: string | null;
  manuallyMarkedPaidAt: Date | null;
  chargeCoverage: Array<{ releasedAt: Date | null }>;
};

function row(memberId: string, overrides: Partial<Row> = {}): Row {
  return {
    memberId,
    seasonYear: SEASON,
    status: "NOT_REQUIRED",
    xeroInvoiceId: null,
    manuallyMarkedPaidAt: null,
    chargeCoverage: [],
    ...overrides,
  };
}

type MemberFixture = {
  id: string;
  ageTier: string;
  dateOfBirth: Date | null;
  firstName?: string;
  lastName?: string;
  active?: boolean;
  archivedAt?: Date | null;
};

function member(
  id: string,
  behavior: MembershipTypeSubscriptionBehavior,
  ageTier: string,
  extra: Omit<MemberFixture, "id" | "ageTier" | "dateOfBirth"> = {},
): MemberFixture {
  behaviors.set(id, behavior);
  return { id, ageTier, dateOfBirth: null, firstName: id, lastName: "Member", active: true, archivedAt: null, ...extra };
}

function makeTx(input: {
  settings: { requiredTypeAgeRule: string; liabilityAgeSource: string } | null;
  rows: Row[];
  members: MemberFixture[];
}) {
  const calls: string[] = [];
  const tx = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const shared = strings.join("?").includes("pg_advisory_xact_lock_shared(") ? "shared:" : "";
      calls.push(`lock:${shared}${String(values[0])}`);
      return 0;
    }),
    membershipLockoutSettings: {
      findUnique: vi.fn(async () => {
        calls.push("settings");
        return input.settings;
      }),
    },
    memberSubscription: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) =>
        input.rows
          .filter((candidate) => matchesWhere(candidate, args.where))
          .map((candidate) => ({ memberId: candidate.memberId })),
      ),
      updateManyAndReturn: vi.fn(
        async (args: { where: Record<string, unknown>; data: { status: string } }) => {
          const matched = input.rows.filter((candidate) => matchesWhere(candidate, args.where));
          for (const candidate of matched) candidate.status = args.data.status;
          return matched.map((candidate) => ({ memberId: candidate.memberId }));
        },
      ),
    },
    member: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        input.members.filter((candidate) => args.where.id.in.includes(candidate.id)),
      ),
    },
    // CHILD is age-exempt; YOUTH and ADULT owe a subscription.
    ageTierSetting: {
      findMany: vi.fn(async () => [
        { tier: "CHILD", minAge: 5, maxAge: 12, label: "Child", sortOrder: 1, subscriptionRequiredForBooking: false, familyGroupRequestCreateMemberAllowed: false },
        { tier: "YOUTH", minAge: 13, maxAge: 17, label: "Youth", sortOrder: 2, subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false },
        { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult", sortOrder: 3, subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false },
      ]),
    },
  };
  return { tx, calls };
}

const CHOSEN = { requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "SEASON_START" };

describe("clearStaleNotRequiredRows (#5190)", () => {
  beforeEach(() => behaviors.clear());

  it("does nothing while the club has not chosen its rule", async () => {
    const rows = [row("youth")];
    const { tx } = makeTx({
      settings: null,
      rows,
      members: [member("youth", "BASED_ON_AGE_TIER", "YOUTH")],
    });

    await expect(clearStaleNotRequiredRows(tx as never, SEASON)).resolves.toEqual(NOTHING_CLEARED);
    expect(rows[0]!.status).toBe("NOT_REQUIRED");
    expect(tx.memberSubscription.updateManyAndReturn).not.toHaveBeenCalled();
  });

  it("takes the billing season key, then the liability-rule key exclusive, before it reads anything", async () => {
    const { tx, calls } = makeTx({ settings: CHOSEN, rows: [], members: [] });
    await clearStaleNotRequiredRows(tx as never, SEASON);
    // Season key first: the rule key is never held while waiting on a confirm.
    expect(calls[0]).toBe("lock:membership-subscription-billing:2026");
    expect(calls[1]).toBe("lock:membership-subscription-liability-rule");
    expect(calls[2]).toBe("settings");
  });

  it("flips only untouched rows whose member owes under the chosen rule, and is idempotent", async () => {
    const released = new Date("2026-05-01T00:00:00.000Z");
    const rows = [
      row("youth"), // owes: flipped
      row("child"), // age-exempt: kept
      row("life"), // NOT_REQUIRED type: kept
      row("no-invoice", { chargeCoverage: [{ releasedAt: null }] }), // covered by a NO_INVOICE fee: kept
      row("re-billable", { chargeCoverage: [{ releasedAt: released }] }), // released claim only: flipped
      row("manual", { manuallyMarkedPaidAt: released }), // manual mark: kept
      row("invoiced", { xeroInvoiceId: "inv-1" }), // invoiced: kept
      row("unresolved"), // no resolvable type: kept
      row("other-season", { seasonYear: SEASON + 1 }), // another season: kept
    ];
    const members = [
      member("youth", "BASED_ON_AGE_TIER", "YOUTH"),
      member("child", "BASED_ON_AGE_TIER", "CHILD"),
      member("life", "NOT_REQUIRED", "ADULT"),
      member("no-invoice", "REQUIRED", "ADULT"),
      member("re-billable", "REQUIRED", "ADULT"),
      member("manual", "REQUIRED", "ADULT"),
      member("invoiced", "REQUIRED", "ADULT"),
      { id: "unresolved", ageTier: "ADULT", dateOfBirth: null },
      member("other-season", "REQUIRED", "ADULT"),
    ];
    const { tx } = makeTx({ settings: CHOSEN, rows, members });

    await expect(clearStaleNotRequiredRows(tx as never, SEASON)).resolves.toEqual({
      clearedCount: 2,
      clearedMemberIds: ["re-billable", "youth"],
    });
    expect(
      Object.fromEntries(rows.map((candidate) => [candidate.memberId, candidate.status])),
    ).toEqual({
      youth: "NOT_INVOICED",
      child: "NOT_REQUIRED",
      life: "NOT_REQUIRED",
      "no-invoice": "NOT_REQUIRED",
      "re-billable": "NOT_INVOICED",
      manual: "NOT_REQUIRED",
      invoiced: "NOT_REQUIRED",
      unresolved: "NOT_REQUIRED",
      "other-season": "NOT_REQUIRED",
    });

    await expect(clearStaleNotRequiredRows(tx as never, SEASON)).resolves.toEqual(NOTHING_CLEARED);
  });

  it("re-asserts the guards at write time, so a claim landing after the read keeps the row", async () => {
    const rows = [row("youth")];
    const { tx } = makeTx({
      settings: CHOSEN,
      rows,
      members: [member("youth", "BASED_ON_AGE_TIER", "YOUTH")],
    });
    // A NO_INVOICE confirm attaches an active claim between the read and the write.
    tx.member.findMany.mockImplementationOnce(async () => {
      rows[0]!.chargeCoverage.push({ releasedAt: null });
      return [{ id: "youth", ageTier: "YOUTH", dateOfBirth: null }];
    });

    await expect(clearStaleNotRequiredRows(tx as never, SEASON)).resolves.toEqual(NOTHING_CLEARED);
    expect(rows[0]!.status).toBe("NOT_REQUIRED");
  });

  it("audits the total and at most the capped number of flipped member ids", () => {
    const ids = Array.from(
      { length: CLEARED_ROWS_AUDIT_MEMBER_ID_LIMIT + 1 },
      (_, index) => `m${String(index).padStart(3, "0")}`,
    );
    expect(
      clearedRowsAuditMetadata({ clearedCount: ids.length, clearedMemberIds: ids }, SEASON),
    ).toEqual({
      seasonYear: SEASON,
      total: ids.length,
      memberIds: ids.slice(0, CLEARED_ROWS_AUDIT_MEMBER_ID_LIMIT),
      memberIdsTruncated: true,
    });
    expect(
      clearedRowsAuditMetadata({ clearedCount: 1, clearedMemberIds: ["m1"] }, SEASON),
    ).toEqual({ seasonYear: SEASON, total: 1, memberIds: ["m1"], memberIdsTruncated: false });
  });
});

describe("findStaleNotRequiredRows: the one selection the preview lists and the clear-up resets (#5190)", () => {
  beforeEach(() => behaviors.clear());

  function fixtures() {
    const archived = new Date("2026-05-01T00:00:00.000Z");
    const rows = [
      row("youth"),
      row("child"),
      row("inactive"),
      row("archived"),
      row("invoiced", { xeroInvoiceId: "inv-1" }),
      row("unresolved"),
    ];
    const members = [
      member("youth", "BASED_ON_AGE_TIER", "YOUTH", { firstName: "Yara", lastName: "Young" }),
      member("child", "BASED_ON_AGE_TIER", "CHILD"),
      member("inactive", "REQUIRED", "ADULT", { firstName: "Ivan", lastName: "Idle", active: false }),
      member("archived", "REQUIRED", "ADULT", { firstName: "Ada", lastName: "Archived", archivedAt: archived }),
      member("invoiced", "REQUIRED", "ADULT"),
      { id: "unresolved", ageTier: "ADULT", dateOfBirth: null },
    ];
    return { rows, members };
  }

  it("selects nobody for a rule that is not chosen", async () => {
    const { tx } = makeTx({ settings: CHOSEN, ...fixtures() });
    await expect(
      findStaleNotRequiredRows(tx as never, {
        seasonYear: SEASON,
        settings: { requiredTypeAgeRule: "NOT_CHOSEN", liabilityAgeSource: "NOT_CHOSEN" },
      }),
    ).resolves.toEqual([]);
    expect(tx.memberSubscription.findMany).not.toHaveBeenCalled();
  });

  it("names every member whose untouched row the rule would reset, flagging those billing never considers", async () => {
    const { tx } = makeTx({ settings: CHOSEN, ...fixtures() });
    await expect(
      findStaleNotRequiredRows(tx as never, { seasonYear: SEASON, settings: CHOSEN as never }),
    ).resolves.toEqual([
      { memberId: "archived", name: "Ada Archived", inBillingPopulation: false },
      { memberId: "inactive", name: "Ivan Idle", inBillingPopulation: false },
      { memberId: "youth", name: "Yara Young", inBillingPopulation: true },
    ]);
  });

  it("is exactly what saving that rule resets: the preview and the clear-up cannot disagree", async () => {
    const { tx } = makeTx({ settings: CHOSEN, ...fixtures() });
    const previewed = await findStaleNotRequiredRows(tx as never, {
      seasonYear: SEASON,
      settings: CHOSEN as never,
    });
    const cleared = await clearStaleNotRequiredRows(tx as never, SEASON);
    expect(cleared.clearedMemberIds).toEqual(previewed.map((stale) => stale.memberId).sort());
    expect(cleared.clearedCount).toBe(previewed.length);
  });
});
