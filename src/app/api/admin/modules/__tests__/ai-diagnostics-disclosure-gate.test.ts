import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR-006 §2 (#5243): PUT /api/admin/modules switches AI Diagnostics on only
// with an acknowledgement of the CURRENT provider disclosure, and records that
// acknowledgement as its own audit row in the same transaction as the write.
const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
  auditCreate: vi.fn(),
  revalidatePublicSite: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/google-config", () => ({ getGoogleSetupState: vi.fn() }));
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
  PUBLIC_LAYOUT_CACHE_TAGS: { modules: "modules", capacity: "capacity" },
}));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicSite: mocks.revalidatePublicSite,
}));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: (args: unknown) => args,
  getAuditRequestContext: () => ({ id: "request-1" }),
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn() } }));

import { PUT } from "../route";
import { DEFAULT_MODULE_SETTINGS } from "@/config/modules";
import { AI_DIAGNOSTICS_DISCLOSURE_VERSION } from "@/lib/ai-diagnostics-disclosure";

function putRequest(
  settings: Record<string, boolean>,
  aiDiagnosticsDisclosureAcknowledgedVersion?: number,
) {
  return new Request("https://club.example.com/api/admin/modules", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings, aiDiagnosticsDisclosureAcknowledgedVersion }),
  });
}

// `create` passes its args through (see the audit mock), so each call returns the
// audit row's structured args, in order, as the transaction's array holds them.
function transactionAuditActions(): unknown[] {
  return mocks.auditCreate.mock.results.map(
    (result) => (result.value as { action: string }).action,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mocks.findUnique.mockResolvedValue({ ...DEFAULT_MODULE_SETTINGS });
  mocks.upsert.mockReturnValue("upsert-promise");
  mocks.update.mockReturnValue("update-promise");
  mocks.auditCreate.mockImplementation((args: unknown) => args);
  mocks.transaction.mockImplementation(async (operations: unknown[]) => [
    { ...DEFAULT_MODULE_SETTINGS, aiDiagnostics: true },
    ...operations.slice(1),
  ]);
});

const enabled = { ...DEFAULT_MODULE_SETTINGS, aiDiagnostics: true };

describe("PUT /api/admin/modules — AI Diagnostics disclosure gate", () => {
  it("refuses to switch Diagnostics on without an acknowledgement, and writes nothing", async () => {
    const res = await PUT(putRequest(enabled));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/where AI Diagnostics sends data/);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("refuses an acknowledgement of a stale disclosure version", async () => {
    const res = await PUT(putRequest(enabled, AI_DIAGNOSTICS_DISCLOSURE_VERSION - 1));
    expect(res.status).toBe(409);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("refuses when no settings row exists yet (a first save)", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const res = await PUT(putRequest(enabled));
    expect(res.status).toBe(409);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("refuses a save from another screen that changes a different module and would switch Diagnostics on", async () => {
    // A whole-set save built from a stale read: magicLink is the change it meant,
    // aiDiagnostics true is a race, and it carries no acknowledgement.
    const res = await PUT(putRequest({ ...enabled, magicLink: true }));
    expect(res.status).toBe(409);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("switches Diagnostics on with the current version and records the acknowledgement in the same transaction", async () => {
    const res = await PUT(putRequest(enabled, AI_DIAGNOSTICS_DISCLOSURE_VERSION));
    expect(res.status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    const operations = (mocks.transaction.mock.calls[0]?.[0] ?? []) as unknown[];
    expect(operations).toHaveLength(3);
    expect(transactionAuditActions()).toEqual([
      "CLUB_MODULE_SETTINGS_UPDATED",
      "AI_DIAGNOSTICS_DISCLOSURE_ACKNOWLEDGED",
    ]);
    expect(operations[2]).toMatchObject({
      action: "AI_DIAGNOSTICS_DISCLOSURE_ACKNOWLEDGED",
      actor: { memberId: "admin-1" },
      entity: { type: "ClubModuleSettings" },
      category: "admin",
      severity: "important",
      metadata: {
        disclosureVersion: AI_DIAGNOSTICS_DISCLOSURE_VERSION,
        recipient: "anthropic",
      },
      request: { id: "request-1" },
    });
  });

  it("needs no acknowledgement to save while Diagnostics is already on, and records none", async () => {
    mocks.findUnique.mockResolvedValue({ ...enabled });
    const res = await PUT(putRequest({ ...enabled, magicLink: true }));
    expect(res.status).toBe(200);
    expect(transactionAuditActions()).toEqual(["CLUB_MODULE_SETTINGS_UPDATED"]);
  });

  it("needs no acknowledgement to switch Diagnostics off", async () => {
    mocks.findUnique.mockResolvedValue({ ...enabled });
    const res = await PUT(putRequest({ ...DEFAULT_MODULE_SETTINGS }));
    expect(res.status).toBe(200);
    expect(transactionAuditActions()).toEqual(["CLUB_MODULE_SETTINGS_UPDATED"]);
  });

  it("rejects a non-integer version as invalid input", async () => {
    const res = await PUT(putRequest(enabled, 1.5));
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("writes an existing row only while aiDiagnostics is still the value the gate judged", async () => {
    mocks.findUnique.mockResolvedValue({ ...enabled });
    await PUT(putRequest({ ...enabled, magicLink: true }));
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default", aiDiagnostics: true },
      }),
    );
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("refuses with 409 when someone switched Diagnostics off between this save's read and its write", async () => {
    // This save read Diagnostics ON and sends it ON (a stale whole-set save from
    // another screen). Meanwhile an administrator switched it off, so the guarded
    // write matches no row: Prisma throws P2025 and the transaction rolls back.
    mocks.findUnique.mockResolvedValue({ ...enabled });
    mocks.transaction.mockRejectedValue(
      Object.assign(new Error("Record to update not found."), { code: "P2025" }),
    );
    const res = await PUT(putRequest({ ...enabled, magicLink: true }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Someone else changed the module settings/);
    expect(mocks.revalidatePublicSite).not.toHaveBeenCalled();
  });

  it("rethrows any other write failure rather than calling it a race", async () => {
    mocks.findUnique.mockResolvedValue({ ...enabled });
    mocks.transaction.mockRejectedValue(
      Object.assign(new Error("boom"), { code: "P1001" }),
    );
    await expect(PUT(putRequest({ ...enabled, magicLink: true }))).rejects.toThrow("boom");
  });
});
