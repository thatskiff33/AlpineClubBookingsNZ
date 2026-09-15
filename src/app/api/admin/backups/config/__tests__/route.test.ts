import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  isFullAdmin: vi.fn(),
  setIntegrationCredential: vi.fn(),
  deleteIntegrationCredential: vi.fn(),
  createAuditLog: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/access-roles", () => ({ isFullAdmin: mocks.isFullAdmin }));
vi.mock("@/lib/integration-credentials", () => ({
  setIntegrationCredential: mocks.setIntegrationCredential,
  deleteIntegrationCredential: mocks.deleteIntegrationCredential,
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
  getAuditRequestContext: () => ({ id: null, ipAddress: "1.2.3.4", userAgent: "t" }),
}));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.loggerError } }));

import { POST } from "../route";

function makeRequest(body: unknown) {
  return new Request("https://club.example.com/api/admin/backups/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function asAdmin(fullAdmin: boolean) {
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1", accessRoles: fullAdmin ? ["ADMIN"] : ["FINANCE_ADMIN"] } },
  });
  mocks.isFullAdmin.mockReturnValue(fullAdmin);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setIntegrationCredential.mockResolvedValue({});
  mocks.deleteIntegrationCredential.mockResolvedValue(undefined);
});

describe("POST /api/admin/backups/config", () => {
  it("lets a support-edit (non-Full-Admin) admin change enabled/retention", async () => {
    asAdmin(false);
    const res = await POST(makeRequest({ enabled: true, retentionDays: 14 }));
    expect(res.status).toBe(200);
    expect(mocks.setIntegrationCredential).toHaveBeenCalledWith(
      expect.objectContaining({ key: "enabled", value: "true" }),
    );
    expect(mocks.setIntegrationCredential).toHaveBeenCalledWith(
      expect.objectContaining({ key: "retention_days", value: "14" }),
    );
  });

  it("refuses a destination change from a non-Full-Admin with 403 and writes nothing", async () => {
    asAdmin(false);
    const res = await POST(makeRequest({ bucket: "my-backups" }));
    expect(res.status).toBe(403);
    expect(mocks.setIntegrationCredential).not.toHaveBeenCalled();
  });

  it("lets a Full Admin set the destination", async () => {
    asAdmin(true);
    const res = await POST(makeRequest({ bucket: "my-backups", region: "us-east-1" }));
    expect(res.status).toBe(200);
    expect(mocks.setIntegrationCredential).toHaveBeenCalledWith(
      expect.objectContaining({ key: "bucket", value: "my-backups" }),
    );
    expect(mocks.setIntegrationCredential).toHaveBeenCalledWith(
      expect.objectContaining({ key: "region", value: "us-east-1" }),
    );
  });

  it("clears the bucket when given an empty string (Full Admin)", async () => {
    asAdmin(true);
    const res = await POST(makeRequest({ bucket: "" }));
    expect(res.status).toBe(200);
    expect(mocks.deleteIntegrationCredential).toHaveBeenCalledWith({
      provider: "backup",
      key: "bucket",
      // The admin who submitted the form, named (#2723), and a declared
      // unconditional clear: the form posts the whole configuration, so there
      // is no read-modify-write here for a second admin to make stale.
      actor: { kind: "admin", memberId: "admin-1" },
      expect: { expect: "any" },
    });
  });

  it("rejects a malformed bucket name with 400", async () => {
    asAdmin(true);
    const res = await POST(makeRequest({ bucket: "Not A Valid Bucket!" }));
    expect(res.status).toBe(400);
    expect(mocks.setIntegrationCredential).not.toHaveBeenCalled();
  });

  it("rejects a malformed region with 400", async () => {
    asAdmin(true);
    const res = await POST(makeRequest({ region: "US East 1" }));
    expect(res.status).toBe(400);
    expect(mocks.setIntegrationCredential).not.toHaveBeenCalled();
  });

  it("rejects an empty body with 400", async () => {
    asAdmin(true);
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });
});
