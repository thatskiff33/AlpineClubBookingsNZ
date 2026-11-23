import { beforeEach, describe, expect, it, vi } from "vitest";

// D2 hard verify gate (#2087): PUT /api/admin/modules refuses to turn googleLogin
// ON until a real OAuth round-trip has verified the stored credentials. This is
// the authoritative server-side lock behind the wizard/security-card UI gates.
const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getGoogleSetupState: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
  auditCreate: vi.fn(),
  invalidate: vi.fn(),
  revalidatePublicSite: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/google-config", () => ({
  getGoogleSetupState: mocks.getGoogleSetupState,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubModuleSettings: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
      update: mocks.update,
    },
    auditLog: { create: mocks.auditCreate },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/public-layout-cache", () => ({
  invalidatePublicLayoutConfig: mocks.invalidate,
  PUBLIC_LAYOUT_CACHE_TAGS: { modules: "modules", capacity: "capacity" },
}));
// The route's success path revalidates the public site (#2352), and
// revalidatePath needs Next's request store, which a unit test has no access
// to — the same mock every sibling route test carries.
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicSite: mocks.revalidatePublicSite,
}));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: (args: unknown) => args,
  getAuditRequestContext: () => ({ id: null }),
}));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.loggerError } }));

import { PUT } from "../route";
import { DEFAULT_MODULE_SETTINGS } from "@/config/modules";

function putRequest(settings: Record<string, boolean>) {
  return new Request("https://club.example.com/api/admin/modules", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  // Currently everything off (googleLogin off).
  mocks.findUnique.mockResolvedValue({ ...DEFAULT_MODULE_SETTINGS });
  mocks.upsert.mockResolvedValue({ ...DEFAULT_MODULE_SETTINGS });
  mocks.update.mockResolvedValue({ ...DEFAULT_MODULE_SETTINGS });
});

describe("PUT /api/admin/modules — googleLogin enable-gate", () => {
  it("REFUSES enabling googleLogin when Google is not verified (409)", async () => {
    mocks.getGoogleSetupState.mockResolvedValue({
      clientIdSet: true,
      clientSecretSet: true,
      needsReentry: false,
      verified: false,
    });
    const res = await PUT(
      putRequest({ ...DEFAULT_MODULE_SETTINGS, googleLogin: true }),
    );
    expect(res.status).toBe(409);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("REFUSES when credentials need re-entry even if a stale verified marker exists", async () => {
    mocks.getGoogleSetupState.mockResolvedValue({
      clientIdSet: true,
      clientSecretSet: true,
      needsReentry: true,
      verified: true,
    });
    const res = await PUT(
      putRequest({ ...DEFAULT_MODULE_SETTINGS, googleLogin: true }),
    );
    expect(res.status).toBe(409);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("REFUSES (fail-closed) when the verified state cannot be resolved", async () => {
    mocks.getGoogleSetupState.mockRejectedValue(new Error("DB down"));
    const res = await PUT(
      putRequest({ ...DEFAULT_MODULE_SETTINGS, googleLogin: true }),
    );
    expect(res.status).toBe(409);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("ALLOWS enabling googleLogin once verified", async () => {
    mocks.getGoogleSetupState.mockResolvedValue({
      clientIdSet: true,
      clientSecretSet: true,
      needsReentry: false,
      verified: true,
    });
    mocks.transaction.mockResolvedValue([
      { ...DEFAULT_MODULE_SETTINGS, googleLogin: true },
    ]);
    const res = await PUT(
      putRequest({ ...DEFAULT_MODULE_SETTINGS, googleLogin: true }),
    );
    expect(res.status).toBe(200);
    // The write ran (via the audited $transaction path, since a module changed).
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.getGoogleSetupState).toHaveBeenCalledTimes(1);
  });

  it("does NOT gate other module changes (no Google check when googleLogin unchanged)", async () => {
    mocks.transaction.mockResolvedValue([
      { ...DEFAULT_MODULE_SETTINGS, magicLink: true },
    ]);
    const res = await PUT(
      putRequest({ ...DEFAULT_MODULE_SETTINGS, magicLink: true }),
    );
    expect(res.status).toBe(200);
    expect(mocks.getGoogleSetupState).not.toHaveBeenCalled();
  });

  it("does NOT gate DISABLING googleLogin", async () => {
    mocks.findUnique.mockResolvedValue({
      ...DEFAULT_MODULE_SETTINGS,
      googleLogin: true,
    });
    mocks.transaction.mockResolvedValue([{ ...DEFAULT_MODULE_SETTINGS }]);
    const res = await PUT(
      putRequest({ ...DEFAULT_MODULE_SETTINGS, googleLogin: false }),
    );
    expect(res.status).toBe(200);
    expect(mocks.getGoogleSetupState).not.toHaveBeenCalled();
  });
});
