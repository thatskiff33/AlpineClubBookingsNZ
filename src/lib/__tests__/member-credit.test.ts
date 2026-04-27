import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock Prisma ─────────────────────────────────────────────────────────────

const prismaMock = {
  memberCredit: {
    aggregate: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    groupBy: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
  },
  adminCreditAdjustmentRequest: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  payment: { findUnique: vi.fn() },
  cancellationPolicy: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  $executeRaw: vi.fn().mockResolvedValue(undefined),
  $transaction: vi.fn(),
};

prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => unknown) =>
  callback(prismaMock)
);

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

function aggregateResult(amountCents: number | null) {
  return {
    _sum: { amountCents },
    _count: null,
    _avg: null,
    _max: null,
    _min: null,
  } as any;
}

type PendingAdjustmentRequest = {
  id: string;
  memberId: string;
  amountCents: number;
  description: string;
  idempotencyKey: string;
  status: string;
  requestedById: string;
  reviewedById?: string;
  reviewedAt?: Date;
};

function pendingRequest(
  overrides: Record<string, unknown> = {}
): PendingAdjustmentRequest {
  return {
    id: "req-1",
    memberId: "member-1",
    amountCents: 2500,
    description: "Service recovery",
    idempotencyKey: "9a13b0af-7ffc-451b-a50b-81f6fb8630f4",
    status: "PENDING",
    requestedById: "admin-requester",
    ...overrides,
  };
}

// ── Tests: Credit Balance Helpers ───────────────────────────────────────────

describe("member-credit helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getMemberCreditBalance", () => {
    it("returns 0 when no credits exist", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.aggregate).mockResolvedValue({
        _sum: { amountCents: null },
        _count: null, _avg: null, _max: null, _min: null,
      } as any);

      const { getMemberCreditBalance } = await import("@/lib/member-credit");
      const balance = await getMemberCreditBalance("member-1");

      expect(balance).toBe(0);
    });

    it("returns correct sum of mixed credits", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.aggregate).mockResolvedValue({
        _sum: { amountCents: 3000 },
        _count: null, _avg: null, _max: null, _min: null,
      } as any);

      const { getMemberCreditBalance } = await import("@/lib/member-credit");
      const balance = await getMemberCreditBalance("member-1");

      expect(balance).toBe(3000);
    });

    it("accepts optional transaction client", async () => {
      const txClient = {
        memberCredit: {
          aggregate: vi.fn().mockResolvedValue({
            _sum: { amountCents: 5000 },
          }),
        },
      };

      const { prisma } = await import("@/lib/prisma");
      const { getMemberCreditBalance } = await import("@/lib/member-credit");
      const balance = await getMemberCreditBalance("member-1", txClient as any);

      expect(balance).toBe(5000);
      expect(txClient.memberCredit.aggregate).toHaveBeenCalled();
      expect(prisma.memberCredit.aggregate).not.toHaveBeenCalled();
    });
  });

  describe("createCancellationCredit", () => {
    it("creates a CANCELLATION_REFUND record with correct fields", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.create).mockResolvedValue({} as any);

      const { createCancellationCredit } = await import("@/lib/member-credit");
      await createCancellationCredit("member-1", 5000, "booking-abc12345", "xero-cn-1");

      expect(prisma.memberCredit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          memberId: "member-1",
          amountCents: 5000,
          type: "CANCELLATION_REFUND",
          sourceBookingId: "booking-abc12345",
          xeroCreditNoteId: "xero-cn-1",
        }),
      });
    });

    it("handles missing Xero credit note ID", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.create).mockResolvedValue({} as any);

      const { createCancellationCredit } = await import("@/lib/member-credit");
      await createCancellationCredit("member-1", 3000, "booking-xyz");

      expect(prisma.memberCredit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          xeroCreditNoteId: null,
        }),
      });
    });
  });

  describe("applyCreditToBooking", () => {
    it("creates a negative BOOKING_APPLIED record", async () => {
      const txClient = {
        $executeRaw: vi.fn().mockResolvedValue(undefined),
        memberCredit: {
          aggregate: vi.fn().mockResolvedValue({
            _sum: { amountCents: 10000 },
          }),
          create: vi.fn().mockResolvedValue({} as any),
        },
      };

      const { applyCreditToBooking } = await import("@/lib/member-credit");
      await applyCreditToBooking("member-1", 5000, "booking-new", txClient as any);

      expect(txClient.memberCredit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          memberId: "member-1",
          amountCents: -5000,
          type: "BOOKING_APPLIED",
          appliedToBookingId: "booking-new",
        }),
      });
    });

    it("throws if insufficient balance", async () => {
      const txClient = {
        $executeRaw: vi.fn().mockResolvedValue(undefined),
        memberCredit: {
          aggregate: vi.fn().mockResolvedValue({
            _sum: { amountCents: 2000 },
          }),
        },
      };

      const { applyCreditToBooking } = await import("@/lib/member-credit");
      await expect(
        applyCreditToBooking("member-1", 5000, "booking-new", txClient as any)
      ).rejects.toThrow("Insufficient credit balance");
    });

    it("throws if amount is zero or negative", async () => {
      const txClient = {
        $executeRaw: vi.fn().mockResolvedValue(undefined),
        memberCredit: { aggregate: vi.fn() },
      };

      const { applyCreditToBooking } = await import("@/lib/member-credit");
      await expect(
        applyCreditToBooking("member-1", 0, "booking-new", txClient as any)
      ).rejects.toThrow("Credit amount must be positive");
    });
  });

  describe("restoreCreditFromBooking", () => {
    it("creates a positive restore entry for cancelled booking", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.findMany).mockResolvedValue([
        { id: "c1", amountCents: -3000, type: "BOOKING_APPLIED" },
        { id: "c2", amountCents: -2000, type: "BOOKING_APPLIED" },
      ] as any);
      vi.mocked(prisma.memberCredit.create).mockResolvedValue({} as any);

      const { restoreCreditFromBooking } = await import("@/lib/member-credit");
      const restored = await restoreCreditFromBooking("member-1", "booking-cancelled");

      expect(restored).toBe(5000);
      expect(prisma.memberCredit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          memberId: "member-1",
          amountCents: 5000,
          type: "CANCELLATION_REFUND",
          sourceBookingId: "booking-cancelled",
        }),
      });
    });

    it("returns 0 when no credit was applied", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.findMany).mockResolvedValue([]);

      const { restoreCreditFromBooking } = await import("@/lib/member-credit");
      const restored = await restoreCreditFromBooking("member-1", "booking-new");

      expect(restored).toBe(0);
      expect(prisma.memberCredit.create).not.toHaveBeenCalled();
    });
  });

  describe("createAdminAdjustment", () => {
    it("creates a pending admin adjustment request", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.adminCreditAdjustmentRequest.findUnique).mockResolvedValueOnce(null);
      vi.mocked(prisma.adminCreditAdjustmentRequest.create).mockResolvedValue({
        ...pendingRequest({
          amountCents: 2000,
          description: "Goodwill credit",
          requestedById: "admin-1",
        }),
      } as any);
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);

      const { createAdminAdjustmentRequest } = await import("@/lib/member-credit");
      const result = await createAdminAdjustmentRequest(
        "member-1",
        2000,
        "Goodwill credit",
        "admin-1",
        "9a13b0af-7ffc-451b-a50b-81f6fb8630f4"
      );

      expect(prisma.adminCreditAdjustmentRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          memberId: "member-1",
          amountCents: 2000,
          description: "Goodwill credit",
          idempotencyKey: "9a13b0af-7ffc-451b-a50b-81f6fb8630f4",
          requestedById: "admin-1",
        }),
        select: expect.any(Object),
      });
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      expect(prisma.memberCredit.create).not.toHaveBeenCalled();
      expect(result.replayed).toBe(false);
      expect(result.request.status).toBe("PENDING");
    });

    it("replays a duplicate request with the same idempotency key", async () => {
      const { prisma } = await import("@/lib/prisma");
      const existingRequest = pendingRequest({
        amountCents: 2000,
        description: "Goodwill credit",
        requestedById: "admin-1",
      });

      vi.mocked(prisma.adminCreditAdjustmentRequest.findUnique)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existingRequest as any);
      vi.mocked(prisma.adminCreditAdjustmentRequest.create).mockResolvedValue(
        existingRequest as any
      );
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);

      const { createAdminAdjustmentRequest } = await import("@/lib/member-credit");
      const first = await createAdminAdjustmentRequest(
        "member-1",
        2000,
        "Goodwill credit",
        "admin-1",
        existingRequest.idempotencyKey
      );
      const replay = await createAdminAdjustmentRequest(
        "member-1",
        2000,
        "Goodwill credit",
        "admin-1",
        existingRequest.idempotencyKey
      );

      expect(prisma.adminCreditAdjustmentRequest.create).toHaveBeenCalledTimes(1);
      expect(first.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      expect(replay.request).toEqual(first.request);
    });

    it("rolls back request creation when the audit write fails", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.adminCreditAdjustmentRequest.findUnique).mockResolvedValueOnce(null);

      const committedRequestIds: string[] = [];
      vi.mocked(prisma.$transaction).mockImplementationOnce(async (callback: (tx: any) => Promise<unknown>) => {
        const stagedRequestIds: string[] = [];
        const tx = {
          adminCreditAdjustmentRequest: {
            create: vi.fn(async ({ data }: any) => {
              stagedRequestIds.push("req-audit-fail");
              return {
                ...pendingRequest({
                  id: "req-audit-fail",
                  amountCents: data.amountCents,
                  description: data.description,
                  idempotencyKey: data.idempotencyKey,
                  requestedById: data.requestedById,
                }),
              };
            }),
          },
          memberCredit: {
            aggregate: vi.fn().mockResolvedValue(aggregateResult(5000)),
          },
          auditLog: {
            create: vi.fn().mockRejectedValue(new Error("audit write failed")),
          },
        };

        try {
          const result = await callback(tx);
          committedRequestIds.push(...stagedRequestIds);
          return result;
        } catch (error) {
          return Promise.reject(error);
        }
      });

      const { createAdminAdjustmentRequest } = await import("@/lib/member-credit");
      await expect(
        createAdminAdjustmentRequest(
          "member-1",
          2000,
          "Goodwill credit",
          "admin-1",
          "9a13b0af-7ffc-451b-a50b-81f6fb8630f4"
        )
      ).rejects.toThrow("audit write failed");

      expect(committedRequestIds).toHaveLength(0);
    });

    it("validates negative adjustment doesn't exceed balance", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.adminCreditAdjustmentRequest.findUnique).mockResolvedValueOnce(null);
      vi.mocked(prisma.adminCreditAdjustmentRequest.create).mockResolvedValue(
        pendingRequest({
          amountCents: -2000,
          description: "Correction",
          requestedById: "admin-1",
        }) as any
      );
      vi.mocked(prisma.memberCredit.aggregate).mockResolvedValue(
        aggregateResult(1000)
      );

      const { createAdminAdjustmentRequest } = await import("@/lib/member-credit");
      await expect(
        createAdminAdjustmentRequest(
          "member-1",
          -2000,
          "Correction",
          "admin-1",
          "9a13b0af-7ffc-451b-a50b-81f6fb8630f4"
        )
      ).rejects.toThrow("Cannot deduct 2000 cents: only 1000 cents available");

      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("rejects zero amount", async () => {
      const { createAdminAdjustmentRequest } = await import("@/lib/member-credit");
      await expect(
        createAdminAdjustmentRequest(
          "member-1",
          0,
          "Nothing",
          "admin-1",
          "9a13b0af-7ffc-451b-a50b-81f6fb8630f4"
        )
      ).rejects.toThrow("Adjustment amount cannot be zero");
    });
  });

  describe("reviewAdminAdjustmentRequest", () => {
    it("approves a pending request and stamps both admins on the credit row", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.adminCreditAdjustmentRequest.findUnique).mockResolvedValue(
        pendingRequest() as any
      );
      vi.mocked(prisma.adminCreditAdjustmentRequest.updateMany).mockResolvedValue({
        count: 1,
      } as any);
      vi.mocked(prisma.memberCredit.create).mockResolvedValue({
        id: "credit-1",
      } as any);
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);

      const { reviewAdminAdjustmentRequest } = await import("@/lib/member-credit");
      const result = await reviewAdminAdjustmentRequest(
        "member-1",
        "req-1",
        "APPROVE",
        "admin-approver"
      );

      expect(prisma.adminCreditAdjustmentRequest.updateMany).toHaveBeenCalledWith({
        where: {
          id: "req-1",
          memberId: "member-1",
          status: "PENDING",
        },
        data: expect.objectContaining({
          status: "APPROVED",
          reviewedById: "admin-approver",
        }),
      });
      expect(prisma.memberCredit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          memberId: "member-1",
          amountCents: 2500,
          type: "ADMIN_ADJUSTMENT",
          description: "Service recovery",
          requestedById: "admin-requester",
          approvedById: "admin-approver",
          approvalRequestId: "req-1",
        }),
      });
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      expect(result.credit).toEqual({ id: "credit-1" });
    });

    it("rejects self-approval", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.adminCreditAdjustmentRequest.findUnique).mockResolvedValue(
        pendingRequest({ requestedById: "admin-1" }) as any
      );

      const { reviewAdminAdjustmentRequest } = await import("@/lib/member-credit");
      await expect(
        reviewAdminAdjustmentRequest("member-1", "req-1", "APPROVE", "admin-1")
      ).rejects.toThrow("A different admin must approve this adjustment");

      expect(prisma.adminCreditAdjustmentRequest.updateMany).not.toHaveBeenCalled();
      expect(prisma.memberCredit.create).not.toHaveBeenCalled();
    });

    it("rejects a pending request without creating a credit row", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.adminCreditAdjustmentRequest.findUnique).mockResolvedValue(
        pendingRequest() as any
      );
      vi.mocked(prisma.adminCreditAdjustmentRequest.updateMany).mockResolvedValue({
        count: 1,
      } as any);
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);

      const { reviewAdminAdjustmentRequest } = await import("@/lib/member-credit");
      const result = await reviewAdminAdjustmentRequest(
        "member-1",
        "req-1",
        "REJECT",
        "admin-approver"
      );

      expect(prisma.adminCreditAdjustmentRequest.updateMany).toHaveBeenCalledWith({
        where: {
          id: "req-1",
          memberId: "member-1",
          status: "PENDING",
        },
        data: expect.objectContaining({
          status: "REJECTED",
          reviewedById: "admin-approver",
        }),
      });
      expect(prisma.memberCredit.create).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      expect(result.credit).toBeNull();
    });

    it("rolls back approval when the audit write fails", async () => {
      const { prisma } = await import("@/lib/prisma");

      const state = {
        credits: [] as Array<{ id: string; amountCents: number; memberId: string }>,
        request: pendingRequest(),
      };

      vi.mocked(prisma.$transaction).mockImplementationOnce(async (callback: (tx: any) => Promise<unknown>) => {
        const stagedCredits: typeof state.credits = [];
        const stagedRequest = {
          ...state.request,
        };
        const lockState: { release: (() => void) | null } = { release: null };
        const tx = {
          $executeRaw: vi.fn(async () => {
            lockState.release = () => undefined;
          }),
          adminCreditAdjustmentRequest: {
            findUnique: vi.fn(async () => ({ ...state.request })),
            updateMany: vi.fn(async () => {
              stagedRequest.status = "APPROVED";
              stagedRequest.reviewedById = "admin-approver";
              return { count: 1 };
            }),
          },
          memberCredit: {
            aggregate: vi.fn().mockResolvedValue(aggregateResult(5000)),
            create: vi.fn(async ({ data }: any) => {
              const credit = { id: "credit-audit-fail", ...data };
              stagedCredits.push(credit);
              return credit;
            }),
          },
          auditLog: {
            create: vi.fn().mockRejectedValue(new Error("audit write failed")),
          },
        };

        try {
          const result = await callback(tx);
          state.credits.push(...stagedCredits);
          state.request = stagedRequest as any;
          return result;
        } finally {
          lockState.release?.();
        }
      });

      const { reviewAdminAdjustmentRequest } = await import("@/lib/member-credit");
      await expect(
        reviewAdminAdjustmentRequest(
          "member-1",
          "req-1",
          "APPROVE",
          "admin-approver"
        )
      ).rejects.toThrow("audit write failed");

      expect(state.credits).toHaveLength(0);
      expect(state.request.status).toBe("PENDING");
      expect((state.request as any).reviewedById).toBeUndefined();
    });

    it("rolls back rejection when the audit write fails", async () => {
      const { prisma } = await import("@/lib/prisma");

      const state = {
        request: pendingRequest(),
      };

      vi.mocked(prisma.$transaction).mockImplementationOnce(async (callback: (tx: any) => Promise<unknown>) => {
        const stagedRequest = {
          ...state.request,
        };
        const tx = {
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          adminCreditAdjustmentRequest: {
            findUnique: vi.fn(async () => ({ ...state.request })),
            updateMany: vi.fn(async () => {
              stagedRequest.status = "REJECTED";
              stagedRequest.reviewedById = "admin-approver";
              return { count: 1 };
            }),
          },
          memberCredit: {
            create: vi.fn(),
          },
          auditLog: {
            create: vi.fn().mockRejectedValue(new Error("audit write failed")),
          },
        };

        try {
          const result = await callback(tx);
          state.request = stagedRequest as any;
          return result;
        } catch (error) {
          return Promise.reject(error);
        }
      });

      const { reviewAdminAdjustmentRequest } = await import("@/lib/member-credit");
      await expect(
        reviewAdminAdjustmentRequest(
          "member-1",
          "req-1",
          "REJECT",
          "admin-approver"
        )
      ).rejects.toThrow("audit write failed");

      expect(state.request.status).toBe("PENDING");
      expect((state.request as any).reviewedById).toBeUndefined();
    });

    it("prevents concurrent negative approvals from overdrawing the balance", async () => {
      const { prisma } = await import("@/lib/prisma");

      const state = {
        credits: [
          {
            id: "credit-seed",
            memberId: "member-1",
            amountCents: 1000,
            type: "CANCELLATION_REFUND",
          },
        ],
        requests: {
          "req-1": pendingRequest({
            id: "req-1",
            amountCents: -700,
            description: "Manual deduction 1",
            requestedById: "admin-requester-1",
          }),
          "req-2": pendingRequest({
            id: "req-2",
            amountCents: -700,
            description: "Manual deduction 2",
            requestedById: "admin-requester-2",
            idempotencyKey: "26822a78-5929-4471-889f-b49f7c88914d",
          }),
        } as Record<string, any>,
        audits: [] as Array<{ action: string }>,
      };

      let lockTail: Promise<void> = Promise.resolve();

      vi.mocked(prisma.$transaction).mockImplementation(async (callback: (tx: any) => Promise<unknown>) => {
        const stagedCredits: any[] = [];
        const stagedRequestUpdates: Array<() => void> = [];
        const stagedAudits: Array<{ action: string }> = [];
        const lockState: { release: (() => void) | null } = { release: null };

        const tx = {
          $executeRaw: vi.fn(async () => {
            const previousLock = lockTail;
            lockTail = new Promise<void>((resolve) => {
              lockState.release = resolve;
            });
            await previousLock;
          }),
          adminCreditAdjustmentRequest: {
            findUnique: vi.fn(async ({ where }: any) => {
              const request = state.requests[where.id];
              return request ? { ...request } : null;
            }),
            updateMany: vi.fn(async ({ where, data }: any) => {
              const request = state.requests[where.id];
              if (!request || request.memberId !== where.memberId || request.status !== where.status) {
                return { count: 0 };
              }

              stagedRequestUpdates.push(() => {
                request.status = data.status;
                request.reviewedById = data.reviewedById;
                request.reviewedAt = data.reviewedAt;
              });

              return { count: 1 };
            }),
          },
          memberCredit: {
            aggregate: vi.fn(async ({ where }: any) => {
              const committedBalance = state.credits
                .filter((credit) => credit.memberId === where.memberId)
                .reduce((sum, credit) => sum + credit.amountCents, 0);
              const stagedBalance = stagedCredits
                .filter((credit) => credit.memberId === where.memberId)
                .reduce((sum, credit) => sum + credit.amountCents, 0);

              return aggregateResult(committedBalance + stagedBalance);
            }),
            create: vi.fn(async ({ data }: any) => {
              const credit = {
                id: `credit-${state.credits.length + stagedCredits.length + 1}`,
                ...data,
              };
              stagedCredits.push(credit);
              return credit;
            }),
          },
          auditLog: {
            create: vi.fn(async ({ data }: any) => {
              stagedAudits.push(data);
              return data;
            }),
          },
        };

        try {
          const result = await callback(tx);
          stagedRequestUpdates.forEach((commit) => commit());
          state.credits.push(...stagedCredits);
          state.audits.push(...stagedAudits);
          return result;
        } finally {
          lockState.release?.();
        }
      });

      const { reviewAdminAdjustmentRequest } = await import("@/lib/member-credit");
      const [firstResult, secondResult] = await Promise.allSettled([
        reviewAdminAdjustmentRequest(
          "member-1",
          "req-1",
          "APPROVE",
          "admin-approver-1"
        ),
        reviewAdminAdjustmentRequest(
          "member-1",
          "req-2",
          "APPROVE",
          "admin-approver-2"
        ),
      ]);

      expect([firstResult.status, secondResult.status].sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);

      const rejectedResult = [firstResult, secondResult].find(
        (result) => result.status === "rejected"
      ) as PromiseRejectedResult;
      expect(rejectedResult.reason.message).toBe(
        "Cannot deduct 700 cents: only 300 cents available"
      );

      const approvedRequests = Object.values(state.requests).filter(
        (request) => request.status === "APPROVED"
      );
      const pendingRequests = Object.values(state.requests).filter(
        (request) => request.status === "PENDING"
      );

      expect(
        state.credits.filter((credit) => credit.type === "ADMIN_ADJUSTMENT")
      ).toHaveLength(1);
      expect(approvedRequests).toHaveLength(1);
      expect(pendingRequests).toHaveLength(1);
    });
  });
});

// ── Tests: Dual Refund Percentages ──────────────────────────────────────────

describe("cancellation dual refund percentages", () => {
  describe("getRefundTier", () => {
    it("returns both card and credit percentages", async () => {
      const { getRefundTier } = await import("@/lib/cancellation");

      const policy = [
        { daysBeforeStay: 14, refundPercentage: 90, creditRefundPercentage: 100, fixedFeeCents: 800, creditFixedFeeCents: 200 },
        { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 75 },
        { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ];

      const tier = getRefundTier(15, policy);
      expect(tier.refundPercentage).toBe(90);
      expect(tier.creditRefundPercentage).toBe(100);
      expect(tier.fixedFeeCents).toBe(800);
      expect(tier.creditFixedFeeCents).toBe(200);
    });

    it("returns correct tier for mid-range days", async () => {
      const { getRefundTier } = await import("@/lib/cancellation");

      const policy = [
        { daysBeforeStay: 14, refundPercentage: 90, creditRefundPercentage: 100 },
        { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 75 },
        { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ];

      const tier = getRefundTier(10, policy);
      expect(tier.refundPercentage).toBe(50);
      expect(tier.creditRefundPercentage).toBe(75);
    });

    it("returns 0/0 for empty policy", async () => {
      const { getRefundTier } = await import("@/lib/cancellation");
      const tier = getRefundTier(10, []);
      expect(tier.refundPercentage).toBe(0);
      expect(tier.creditRefundPercentage).toBe(0);
    });
  });

  describe("calculateRefundAmount", () => {
    it("uses card percentage by default", async () => {
      const { calculateRefundAmount } = await import("@/lib/cancellation");

      const policy = [
        { daysBeforeStay: 14, refundPercentage: 90, creditRefundPercentage: 100, fixedFeeCents: 1000, creditFixedFeeCents: 300 },
        { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ];

      const result = calculateRefundAmount(10000, 15, policy);
      expect(result.refundAmountCents).toBe(8000);
      expect(result.refundPercentage).toBe(90);
    });

    it("uses credit percentage when refundMethod is credit", async () => {
      const { calculateRefundAmount } = await import("@/lib/cancellation");

      const policy = [
        { daysBeforeStay: 14, refundPercentage: 90, creditRefundPercentage: 100, fixedFeeCents: 1000, creditFixedFeeCents: 300 },
        { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ];

      const result = calculateRefundAmount(10000, 15, policy, "credit");
      expect(result.refundAmountCents).toBe(9700);
      expect(result.refundPercentage).toBe(100);
    });
  });

  describe("calculateDualRefundAmounts", () => {
    it("returns both card and credit amounts", async () => {
      const { calculateDualRefundAmounts } = await import("@/lib/cancellation");

      const policy = [
        { daysBeforeStay: 14, refundPercentage: 90, creditRefundPercentage: 100, fixedFeeCents: 1000, creditFixedFeeCents: 250 },
        { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 75 },
        { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ];

      const result = calculateDualRefundAmounts(10000, 15, policy);
      expect(result.cardRefundAmountCents).toBe(8000);
      expect(result.cardRefundPercentage).toBe(90);
      expect(result.creditRefundAmountCents).toBe(9750);
      expect(result.creditRefundPercentage).toBe(100);
    });

    it("rounds correctly for odd amounts", async () => {
      const { calculateDualRefundAmounts } = await import("@/lib/cancellation");

      const policy = [
        { daysBeforeStay: 7, refundPercentage: 33, creditRefundPercentage: 50 },
        { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ];

      const result = calculateDualRefundAmounts(999, 10, policy);
      expect(result.cardRefundAmountCents).toBe(330);
      expect(result.creditRefundAmountCents).toBe(500);
    });
  });
});

// ── Tests: Schema Contracts ─────────────────────────────────────────────────

describe("schema contracts", () => {
  it("adjustment schema requires description", async () => {
    const { z } = await import("zod");
    const schema = z.object({
      amountCents: z.number().int().refine((v: number) => v !== 0, "Amount cannot be zero"),
      description: z.string().min(1, "Description is required").max(500),
      idempotencyKey: z.string().uuid("Idempotency key must be a UUID"),
    });

    expect(schema.safeParse({ amountCents: 100 }).success).toBe(false);
    expect(schema.safeParse({ amountCents: 100, description: "" }).success).toBe(false);
    expect(schema.safeParse({
      amountCents: 0,
      description: "test",
      idempotencyKey: "9a13b0af-7ffc-451b-a50b-81f6fb8630f4",
    }).success).toBe(false);
    expect(schema.safeParse({
      amountCents: 100,
      description: "test",
      idempotencyKey: "9a13b0af-7ffc-451b-a50b-81f6fb8630f4",
    }).success).toBe(true);
    expect(schema.safeParse({
      amountCents: -500,
      description: "deduct",
      idempotencyKey: "9a13b0af-7ffc-451b-a50b-81f6fb8630f4",
    }).success).toBe(true);
  });

  it("cancellation policy schema accepts creditRefundPercentage", async () => {
    const { z } = await import("zod");
    const policySchema = z.object({
      rules: z.array(
        z.object({
          daysBeforeStay: z.number().int().min(0),
          refundPercentage: z.number().int().min(0).max(100),
          creditRefundPercentage: z.number().int().min(0).max(100).optional(),
          fixedFeeCents: z.number().int().min(0).optional(),
          creditFixedFeeCents: z.number().int().min(0).optional(),
        })
      ).min(1),
    });

    expect(policySchema.safeParse({
      rules: [{ daysBeforeStay: 14, refundPercentage: 90 }],
    }).success).toBe(true);

    expect(policySchema.safeParse({
      rules: [{ daysBeforeStay: 14, refundPercentage: 90, creditRefundPercentage: 100 }],
    }).success).toBe(true);

    expect(policySchema.safeParse({
      rules: [{ daysBeforeStay: 14, refundPercentage: 90, fixedFeeCents: 500, creditFixedFeeCents: 250 }],
    }).success).toBe(true);
  });
});
