import { describe, expect, it, vi } from "vitest";

import {
  enqueueActiveHostingIncidentPolicyReconciliation,
  type HostingPolicyReconciliationSnapshot,
} from "@/lib/adult-member-hosting-policy-reconciliation";

const club = (
  overrides: Partial<HostingPolicyReconciliationSnapshot> = {},
): HostingPolicyReconciliationSnapshot => ({
  id: "club-policy",
  scopeKey: "club-wide",
  lodgeId: null,
  mode: "ENFORCED",
  capacityMode: "NO_HOLD",
  version: 1,
  hostScopeSameBooking: true,
  hostScopeSameBookingOwner: false,
  hostScopeSameGroupTrip: false,
  ...overrides,
});

const lodge = (
  lodgeId: string,
  overrides: Partial<HostingPolicyReconciliationSnapshot> = {},
): HostingPolicyReconciliationSnapshot => ({
  id: `policy-${lodgeId}`,
  scopeKey: lodgeId,
  lodgeId,
  mode: "INHERIT",
  capacityMode: "NO_HOLD",
  version: 1,
  hostScopeSameBooking: null,
  hostScopeSameBookingOwner: null,
  hostScopeSameGroupTrip: null,
  ...overrides,
});

function candidate(id: string, lodgeId: string, memberId = `owner-${id}`) {
  return {
    id: `booking-${id}`,
    memberId,
    lodgeId,
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-03T00:00:00.000Z"),
  };
}

function dbDouble(params: {
  afterPolicies: HostingPolicyReconciliationSnapshot[];
  candidates: ReturnType<typeof candidate>[];
}) {
  const createMany = vi.fn(
    async ({ data }: { data: Array<Record<string, unknown>> }) => ({
      count: data.length,
    }),
  );
  const findCandidates = vi.fn().mockResolvedValue(params.candidates);
  const findPolicies = vi.fn().mockResolvedValue(params.afterPolicies);
  return {
    createMany,
    findCandidates,
    findPolicies,
    db: {
      adultMemberHostingPolicy: { findMany: findPolicies },
      booking: { findMany: findCandidates },
      hostingCoverageReevaluation: { createMany },
    } as never,
  };
}

describe("adult-hosting policy incident reconciliation", () => {
  it("discovers a confirmed booking with no incident when policy tightens", async () => {
    const before = [club({ mode: "ADMIN_REVIEW_REQUIRED" })];
    const { db, createMany, findCandidates } = dbDouble({
      afterPolicies: [club({ mode: "ENFORCED", version: 2 })],
      candidates: [candidate("accepted", "lodge-a")],
    });

    await expect(
      enqueueActiveHostingIncidentPolicyReconciliation(
        { beforePolicies: before, todayDateOnly: "2026-08-01" },
        db,
      ),
    ).resolves.toBe(1);
    expect(findCandidates).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            deletedAt: null,
            status: { in: ["CONFIRMED", "PAID"] },
            checkOut: { gt: new Date("2026-08-01T00:00:00.000Z") },
          },
          { hostingCoverageIncidents: { some: { resolvedAt: null } } },
        ],
      },
      orderBy: [{ checkIn: "asc" }, { id: "asc" }],
      select: {
        id: true,
        memberId: true,
        lodgeId: true,
        checkIn: true,
        checkOut: true,
      },
    });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          memberId: "owner-accepted",
          lodgeId: "lodge-a",
          nights: ["2026-08-01", "2026-08-02"],
          cause: "SYSTEM_CHANGE",
          sourceBookingId: "booking-accepted",
          actorMemberId: null,
          reason: null,
        }),
      ],
    });
  });

  it("keeps an active-incident booking as a relaxation closure candidate", async () => {
    const before = [club({ mode: "ENFORCED" })];
    const { db, createMany } = dbDouble({
      afterPolicies: [club({ mode: "DISABLED", version: 2 })],
      // The query's active-incident OR branch returns this even if it has left
      // the accepted status set; the drain must still close its incident.
      candidates: [candidate("cancelled-with-incident", "lodge-a")],
    });

    await expect(
      enqueueActiveHostingIncidentPolicyReconciliation(
        { beforePolicies: before },
        db,
      ),
    ).resolves.toBe(1);
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          sourceBookingId: "booking-cancelled-with-incident",
          cause: "SYSTEM_CHANGE",
        }),
      ],
    });
  });

  it("uses one set-based insert for every affected booking and never stamps the admin actor", async () => {
    const before = [club({ mode: "ADMIN_REVIEW_REQUIRED" })];
    const { db, createMany, findCandidates, findPolicies } = dbDouble({
      afterPolicies: [club({ mode: "ENFORCED", version: 2 })],
      candidates: [
        candidate("a", "lodge-a"),
        candidate("b", "lodge-a"),
        candidate("c", "lodge-b"),
      ],
    });

    await expect(
      enqueueActiveHostingIncidentPolicyReconciliation(
        { beforePolicies: before },
        db,
      ),
    ).resolves.toBe(3);
    expect(findPolicies).toHaveBeenCalledTimes(1);
    expect(findCandidates).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledTimes(1);
    const rows = createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceBookingId: "booking-a" }),
        expect.objectContaining({ sourceBookingId: "booking-b" }),
        expect.objectContaining({ sourceBookingId: "booking-c" }),
      ]),
    );
    expect(rows.every((row) => row.actorMemberId === null)).toBe(true);
  });

  it("queues only lodges whose effective inherited policy changed", async () => {
    const before = [
      club({ mode: "ENFORCED" }),
      lodge("lodge-b", {
        mode: "ENFORCED",
        hostScopeSameBooking: true,
        hostScopeSameBookingOwner: false,
      }),
    ];
    const { db, createMany } = dbDouble({
      afterPolicies: [
        club({ mode: "ADMIN_REVIEW_REQUIRED", version: 2 }),
        before[1],
      ],
      candidates: [candidate("a", "lodge-a"), candidate("b", "lodge-b")],
    });

    await expect(
      enqueueActiveHostingIncidentPolicyReconciliation(
        { beforePolicies: before },
        db,
      ),
    ).resolves.toBe(1);
    expect(createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ sourceBookingId: "booking-a" }),
    ]);
  });

  it("queues a still-enforced booking when its effective host scopes change", async () => {
    const before = [club()];
    const { db, createMany } = dbDouble({
      afterPolicies: [
        club({
          version: 2,
          hostScopeSameBookingOwner: true,
        }),
      ],
      candidates: [candidate("a", "lodge-a")],
    });

    await expect(
      enqueueActiveHostingIncidentPolicyReconciliation(
        { beforePolicies: before },
        db,
      ),
    ).resolves.toBe(1);
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it("does not write queue rows for revision or capacity-only changes", async () => {
    const before = [club()];
    const { db, createMany } = dbDouble({
      afterPolicies: [club({ version: 2, capacityMode: "HOLD" })],
      candidates: [candidate("a", "lodge-a")],
    });

    await expect(
      enqueueActiveHostingIncidentPolicyReconciliation(
        { beforePolicies: before },
        db,
      ),
    ).resolves.toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("propagates a bulk enqueue failure so the policy transaction can roll back", async () => {
    const before = [club()];
    const { db, createMany } = dbDouble({
      afterPolicies: [club({ mode: "DISABLED", version: 2 })],
      candidates: [candidate("a", "lodge-a")],
    });
    createMany.mockRejectedValueOnce(new Error("queue unavailable"));

    await expect(
      enqueueActiveHostingIncidentPolicyReconciliation(
        { beforePolicies: before },
        db,
      ),
    ).rejects.toThrow("queue unavailable");
  });
});
