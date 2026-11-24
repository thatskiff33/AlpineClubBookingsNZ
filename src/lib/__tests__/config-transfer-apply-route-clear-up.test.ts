import { beforeEach, describe, expect, it, vi } from "vitest";

// #5190 review: a configuration import that committed, but whose post-commit
// liability clear-up failed, is still a successful import. The route answers
// 200 with the flag, refreshes every cache as usual, and writes no "refused"
// audit row. `config-transfer-liability-clear-up.test.ts` proves that a
// throwing clear-up comes back from `applyConfigImport` as this flag.

const mocks = vi.hoisted(() => ({
  applyConfigImport: vi.fn(),
  createAuditLog: vi.fn(),
  revalidatePublicPageContent: vi.fn(),
  invalidatePublicLayoutConfig: vi.fn(),
  primeEmailPalette: vi.fn(),
  primeClubIdentitySync: vi.fn(),
  invalidateAgeTierCache: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));
vi.mock("@/lib/config-transfer/apply", () => {
  class Refusal extends Error {}
  return {
    applyConfigImport: mocks.applyConfigImport,
    ConfigImportBackupError: class extends Refusal {},
    ConfigImportDriftError: class extends Refusal {},
    ConfigImportValidationError: class extends Refusal {
      errors: string[] = [];
    },
  };
});
vi.mock("@/lib/config-transfer/route-helpers", () => ({
  requireFullAdminForConfigTransfer: async () => ({ ok: true, memberId: "admin-1" }),
  readBundleUpload: async () => ({
    ok: true,
    upload: {
      bytes: new Uint8Array(),
      mode: "merge",
      resolutions: [],
      expectedFingerprint: "fp",
    },
  }),
}));
vi.mock("@/lib/require-recent-auth", () => ({ requireRecentAuth: async () => ({ ok: true }) }));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: async () => ({}) }));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: mocks.revalidatePublicPageContent,
}));
vi.mock("@/lib/public-layout-cache", () => ({
  invalidatePublicLayoutConfig: mocks.invalidatePublicLayoutConfig,
  PUBLIC_LAYOUT_CACHE_TAGS: {
    modules: "m",
    theme: "t",
    capacity: "c",
    banners: "b",
    identity: "i",
  },
}));
vi.mock("@/lib/email-theme", () => ({ primeEmailPalette: mocks.primeEmailPalette }));
vi.mock("@/lib/club-identity-settings", () => ({
  primeClubIdentitySync: mocks.primeClubIdentitySync,
}));
vi.mock("@/lib/age-tier", () => ({ invalidateAgeTierCache: mocks.invalidateAgeTierCache }));

import { POST } from "@/app/api/admin/config-transfer/apply/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.applyConfigImport.mockResolvedValue({
    perCategory: [],
    totals: { created: 0, updated: 1, deleted: 0, unchanged: 0, skipped: 0 },
    backup: { attempted: true, skipped: false },
    doorCodesWritten: [],
    appliedEntities: ["membership-lockout-settings", "age-tier"],
    liabilityClearUp: "failed",
  });
});

describe("config-transfer apply route: a failed post-import clear-up (#5190)", () => {
  it("answers 200 with the flag and still refreshes every cache", async () => {
    const response = await POST(new Request("http://localhost/api/admin/config-transfer/apply", { method: "POST" }));
    expect(response.status).toBe(200);
    expect((await response.json()).result.liabilityClearUp).toBe("failed");
    expect(mocks.revalidatePublicPageContent).toHaveBeenCalled();
    expect(mocks.invalidatePublicLayoutConfig).toHaveBeenCalled();
    expect(mocks.primeEmailPalette).toHaveBeenCalled();
    expect(mocks.primeClubIdentitySync).toHaveBeenCalled();
    expect(mocks.invalidateAgeTierCache).toHaveBeenCalled();
    expect(
      mocks.createAuditLog.mock.calls.map(([entry]) => (entry as { action: string }).action),
    ).not.toContain("configuration.import_refused");
  });
});
