import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  credFindUnique: vi.fn(),
  settingsFindUnique: vi.fn(),
  getIntegrationCredentialValue: vi.fn(),
  providerNeedsReentry: vi.fn(),
  checkDiagnosticsDatabaseReadiness: vi.fn(),
}));

// AID-5 (#2374): the readiness aggregate now VERIFIES the dedicated SELECT-only
// role. Mocked here because the real function opens a `pg` pool; the real thing is
// proven against an actual PostgreSQL in
// `ai-diagnostics-select-only-role.realdb.test.ts`.
vi.mock("@/lib/diagnostics/tools/database", () => ({
  checkDiagnosticsDatabaseReadiness: mocks.checkDiagnosticsDatabaseReadiness,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: { findUnique: mocks.credFindUnique },
    diagnosticsSettings: { findUnique: mocks.settingsFindUnique },
  },
}));

vi.mock("@/lib/integration-credentials", () => ({
  getIntegrationCredentialValue: mocks.getIntegrationCredentialValue,
  providerNeedsReentry: mocks.providerNeedsReentry,
}));

import {
  DIAGNOSTICS_CREDENTIAL_KEYS,
  DIAGNOSTICS_PROVIDER,
  getDiagnosticsReadiness,
  getOperationalDiagnosticsApiKey,
} from "@/lib/ai-diagnostics-config";
import { ANTHROPIC_PROVIDER } from "@/lib/ai-assistant-config";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.credFindUnique.mockResolvedValue({ updatedAt: new Date("2026-08-02T00:00:00Z") });
  mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 1000 });
  mocks.getIntegrationCredentialValue.mockResolvedValue("sk-ant-diag-xxx");
  mocks.providerNeedsReentry.mockResolvedValue(false);
  mocks.checkDiagnosticsDatabaseReadiness.mockResolvedValue({
    state: "verified",
    roleName: "ai_diagnostics_ro",
  });
});

describe("dedicated credential — NO sharing with page-help", () => {
  it("uses a DISTINCT provider namespace from the page-help Anthropic key", () => {
    expect(DIAGNOSTICS_PROVIDER).toBe("anthropic-diagnostics");
    expect(DIAGNOSTICS_PROVIDER).not.toBe(ANTHROPIC_PROVIDER);
  });

  it("resolves the operational key from the DEDICATED provider only", async () => {
    await getOperationalDiagnosticsApiKey();
    expect(mocks.getIntegrationCredentialValue).toHaveBeenCalledWith(
      DIAGNOSTICS_PROVIDER,
      DIAGNOSTICS_CREDENTIAL_KEYS.apiKey,
    );
    // It must NEVER fall back to the page-help "anthropic" provider.
    expect(mocks.getIntegrationCredentialValue).not.toHaveBeenCalledWith(
      ANTHROPIC_PROVIDER,
      expect.anything(),
    );
  });

  it("returns undefined (never a page-help key) when the dedicated key is absent", async () => {
    mocks.getIntegrationCredentialValue.mockResolvedValue(null);
    expect(await getOperationalDiagnosticsApiKey()).toBeUndefined();
  });
});

describe("getDiagnosticsReadiness — fail-closed gate", () => {
  it("is READY only when module on + key saved + positive budget + VERIFIED SELECT-only role", async () => {
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(r).toMatchObject({
      ready: true,
      moduleEnabled: true,
      keyState: "saved",
      monthlyBudgetCents: 1000,
      databaseState: "verified",
      blockers: [],
    });
  });

  it("is NOT ready while the module is off (even with key + budget)", async () => {
    const r = await getDiagnosticsReadiness({ aiDiagnostics: false });
    expect(r.ready).toBe(false);
    expect(r.blockers).toContain("module_off");
  });

  it("is NOT ready when the dedicated key is not configured", async () => {
    mocks.credFindUnique.mockResolvedValue(null);
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(r.ready).toBe(false);
    expect(r.keyState).toBe("not_configured");
    expect(r.blockers).toContain("credential_not_configured");
  });

  it("is NOT ready when the dedicated key needs re-entry (auth secret rotated)", async () => {
    mocks.providerNeedsReentry.mockResolvedValue(true);
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(r.ready).toBe(false);
    expect(r.keyState).toBe("needs_reentry");
    expect(r.blockers).toContain("credential_needs_reentry");
  });

  it("is NOT ready when the budget is zero (ship default, hard-off)", async () => {
    mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 0 });
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(r.ready).toBe(false);
    expect(r.blockers).toContain("budget_not_set");
  });

  it("is NOT ready (no throw) on a DB fault — fail closed with resolve_error", async () => {
    mocks.settingsFindUnique.mockRejectedValue(new Error("db down"));
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(r.ready).toBe(false);
    expect(r.blockers).toEqual(["resolve_error"]);
    // Even the catch-all reports an UNVERIFIED role — never a verified one.
    expect(r.databaseState).toBe("unverified");
  });

  // AID-5 (#2374): the dedicated SELECT-only role is mandatory (ADR-007), and
  // readiness must VERIFY it rather than trust that the env var is set. Every
  // non-verified state blocks, and the state is reported distinctly so an operator
  // knows whether to provision, repair or fix connectivity.
  it("is NOT ready when the SELECT-only role is not configured at all", async () => {
    mocks.checkDiagnosticsDatabaseReadiness.mockResolvedValue({
      state: "not_configured",
      roleName: null,
    });
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(r.ready).toBe(false);
    expect(r.databaseState).toBe("not_configured");
    expect(r.blockers).toContain("database_not_configured");
    // The absent-role case is NOT reported as an unsafe role: different fix.
    expect(r.blockers).not.toContain("database_role_unsafe");
  });

  it.each([
    ["misconfigured", "malformed URL, no role, or the application's own role"],
    ["unverified", "the server could not be asked, so the role is not trusted"],
    ["over_privileged", "the server says the role is not SELECT-only"],
  ])("is NOT ready when the SELECT-only role is %s (%s)", async (state) => {
    mocks.checkDiagnosticsDatabaseReadiness.mockResolvedValue({
      state,
      roleName: null,
    });
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(r.ready).toBe(false);
    expect(r.databaseState).toBe(state);
    expect(r.blockers).toContain("database_role_unsafe");
  });

  it("reports a missing-grants blocker for an under-provisioned role", async () => {
    mocks.checkDiagnosticsDatabaseReadiness.mockResolvedValue({
      state: "under_provisioned",
      roleName: null,
    });
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(r.ready).toBe(false);
    expect(r.blockers).toContain("database_grants_missing");
    expect(r.blockers).not.toContain("database_role_unsafe");
  });

  it("never reports a role name on the readiness response (metadata only)", async () => {
    // The role name is deployment configuration, but a readiness response is JSON
    // an admin browser receives — nothing about the credential belongs in it
    // beyond the state. This pins that the aggregate drops the name.
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(JSON.stringify(r)).not.toContain("ai_diagnostics_ro");
    expect(Object.keys(r)).not.toContain("roleName");
  });
});
