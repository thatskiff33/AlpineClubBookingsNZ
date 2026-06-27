import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAuth,
  mockFindUnique,
  mockRunManualFinanceSync,
  mockRevalidatePath,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindUnique: vi.fn(),
  mockRunManualFinanceSync: vi.fn(),
  mockRevalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mockFindUnique,
    },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

vi.mock("@/lib/finance-sync-manual", () => ({
  runManualFinanceSync: mockRunManualFinanceSync,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
  },
}));

import { POST as runFinanceSyncRoute } from "@/app/api/finance/sync/run/route";

function managerSession() {
  return { user: { id: "finance-manager-1", role: "ADMIN" } };
}

function viewerMember() {
  return {
    id: "finance-viewer-1",
    email: "viewer@example.com",
    firstName: "View",
    lastName: "Only",
    role: "MEMBER",
    financeAccessLevel: "VIEWER",
    active: true,
    forcePasswordChange: false,
  };
}

function managerMember() {
  return {
    id: "finance-manager-1",
    email: "manager@example.com",
    firstName: "Fin",
    lastName: "Manager",
    role: "ADMIN",
    financeAccessLevel: "MANAGER",
    active: true,
    forcePasswordChange: false,
  };
}

describe("finance manual sync route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXTAUTH_URL", "https://example.org");
    mockAuth.mockResolvedValue(managerSession());
    mockFindUnique.mockResolvedValue(managerMember());
  });

  it("redirects unauthenticated requests to login", async () => {
    mockAuth.mockResolvedValue(null);

    const response = await runFinanceSyncRoute(
      new Request("https://example.org/api/finance/sync/run", {
        method: "POST",
      }) as never
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://example.org/login");
    expect(mockRunManualFinanceSync).not.toHaveBeenCalled();
  });

  it("redirects finance viewers back to /finance", async () => {
    mockFindUnique.mockResolvedValue(viewerMember());

    const response = await runFinanceSyncRoute(
      new Request("https://example.org/api/finance/sync/run", {
        method: "POST",
      }) as never
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://example.org/finance");
    expect(mockRunManualFinanceSync).not.toHaveBeenCalled();
  });

  it("redirects with a success notice after a completed sync", async () => {
    mockRunManualFinanceSync.mockResolvedValue({
      outcome: "finished",
      execution: {
        runId: "run-1",
        workflow: "daily-finance-sync",
        trigger: "MANUAL",
        status: "SUCCEEDED",
        xeroTenantId: "tenant-1",
        startedAt: new Date("2026-05-02T00:00:00.000Z"),
        completedAt: new Date("2026-05-02T00:05:00.000Z"),
        snapshotCount: 4,
        totalRowCount: 120,
        datasetResults: [],
      },
    });

    const response = await runFinanceSyncRoute(
      new Request("https://example.org/api/finance/sync/run", {
        method: "POST",
      }) as never
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://example.org/finance?sync=completed"
    );
    expect(mockRunManualFinanceSync).toHaveBeenCalledWith({
      requestedByMemberId: "finance-manager-1",
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/finance");
    expect(mockRevalidatePath).toHaveBeenCalledTimes(1);
  });

  it("redirects with a warning when another sync is already running", async () => {
    mockRunManualFinanceSync.mockResolvedValue({
      outcome: "already-running",
      runId: "run-1",
      startedAt: new Date("2026-05-02T00:00:00.000Z"),
    });

    const response = await runFinanceSyncRoute(
      new Request("https://example.org/api/finance/sync/run", {
        method: "POST",
      }) as never
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://example.org/finance?sync=running"
    );
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("redirects with a warning when the sync completes partially", async () => {
    mockRunManualFinanceSync.mockResolvedValue({
      outcome: "finished",
      execution: {
        runId: "run-1",
        workflow: "daily-finance-sync",
        trigger: "MANUAL",
        status: "PARTIAL",
        xeroTenantId: "tenant-1",
        startedAt: new Date("2026-05-02T00:00:00.000Z"),
        completedAt: new Date("2026-05-02T00:05:00.000Z"),
        snapshotCount: 2,
        totalRowCount: 40,
        datasetResults: [],
      },
    });

    const response = await runFinanceSyncRoute(
      new Request("https://example.org/api/finance/sync/run", {
        method: "POST",
      }) as never
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://example.org/finance?sync=partial"
    );
  });

  it("redirects with an error notice when the sync fails", async () => {
    mockRunManualFinanceSync.mockRejectedValue(
      new Error("Finance Xero token is expired")
    );

    const response = await runFinanceSyncRoute(
      new Request("https://example.org/api/finance/sync/run", {
        method: "POST",
      }) as never
    );

    expect(response.status).toBe(303);

    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/finance");
    expect(location.searchParams.get("sync")).toBe("failed");
    expect(location.searchParams.has("syncError")).toBe(false);
  });
});
