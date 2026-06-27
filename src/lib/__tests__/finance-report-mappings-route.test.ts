import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockCreateAuditLog,
  mockGetFinanceReportMappingsState,
  mockLoadFinanceAccessMember,
  mockRequireAdmin,
  mockRevalidatePath,
  mockSaveFinanceReportMappings,
} = vi.hoisted(() => ({
  mockCreateAuditLog: vi.fn(),
  mockGetFinanceReportMappingsState: vi.fn(),
  mockLoadFinanceAccessMember: vi.fn(),
  mockRequireAdmin: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockSaveFinanceReportMappings: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mockRequireAdmin,
}));

vi.mock("@/lib/finance-auth", () => ({
  hasFinanceManagerAccess: (level: string) => level === "MANAGER",
  loadFinanceAccessMember: mockLoadFinanceAccessMember,
}));

vi.mock("@/lib/finance-report-mappings", () => ({
  getFinanceReportMappingsState: mockGetFinanceReportMappingsState,
  saveFinanceReportMappings: mockSaveFinanceReportMappings,
}));

vi.mock("@/lib/audit", () => ({
  createAuditLog: mockCreateAuditLog,
  getAuditRequestContext: () => ({
    id: "request-1",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  }),
}));

import {
  GET as getFinanceReportMappings,
  PUT as putFinanceReportMappings,
} from "@/app/api/admin/setup/finance-report-mappings/route";

const mappingState = {
  categories: [
    {
      id: "cat-hut-fees",
      kind: "REVENUE",
      name: "Hut Fees",
      sortOrder: 10,
      archived: false,
      mappings: [],
    },
  ],
  unmappedLines: [],
  snapshotCoverage: {
    latestProfitAndLossSnapshot: null,
    inspectedSnapshotCount: 0,
  },
};

function adminGuard() {
  return {
    ok: true,
    session: { user: { id: "admin-1" } },
  };
}

function request(body: unknown) {
  return new NextRequest("https://example.org/api/admin/setup/finance-report-mappings", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-1",
      "user-agent": "vitest",
    },
    body: JSON.stringify(body),
  });
}

describe("admin finance report mappings route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(adminGuard());
    mockLoadFinanceAccessMember.mockResolvedValue({
      id: "admin-1",
      financeAccessLevel: "MANAGER",
    });
    mockGetFinanceReportMappingsState.mockResolvedValue(mappingState);
  });

  it("requires admin access for reads", async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await getFinanceReportMappings();

    expect(response.status).toBe(403);
    expect(mockGetFinanceReportMappingsState).not.toHaveBeenCalled();
  });

  it("requires admin plus finance manager access for writes", async () => {
    mockLoadFinanceAccessMember.mockResolvedValue({
      id: "admin-1",
      financeAccessLevel: "VIEWER",
    });

    const response = await putFinanceReportMappings(
      request({ categories: [{ kind: "REVENUE", name: "Hut Fees" }] })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Admin finance manager access required",
    });
    expect(mockSaveFinanceReportMappings).not.toHaveBeenCalled();
  });

  it("validates input before saving", async () => {
    const response = await putFinanceReportMappings(
      request({ categories: [{ kind: "OTHER", name: "" }] })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid input",
    });
    expect(mockSaveFinanceReportMappings).not.toHaveBeenCalled();
  });

  it("persists mappings, audits the save, and revalidates finance surfaces", async () => {
    const response = await putFinanceReportMappings(
      request({
        categories: [
          {
            id: "cat-hut-fees",
            kind: "REVENUE",
            name: "Hut Fees",
            sortOrder: 10,
            archived: false,
            mappings: [{ accountCode: "200" }],
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    expect(mockSaveFinanceReportMappings).toHaveBeenCalledWith({
      categories: [
        {
          id: "cat-hut-fees",
          kind: "REVENUE",
          name: "Hut Fees",
          sortOrder: 10,
          archived: false,
          mappings: [
            {
              accountCode: "200",
              sectionLabel: null,
              lineLabel: null,
            },
          ],
        },
      ],
    });
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "finance_report_mappings.save",
        memberId: "admin-1",
        actorMemberId: "admin-1",
        category: "xero",
        outcome: "success",
      })
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/finance");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/setup");
    await expect(response.json()).resolves.toEqual(mappingState);
  });
});
