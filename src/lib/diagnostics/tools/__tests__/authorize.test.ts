/**
 * Tool authorization is deliberately a thin verdict over AID-4's fresh matrix
 * reader, so these tests are about the verdict and the freshness, not about
 * re-testing the reader: that a role read happens on EVERY call, that a database
 * fault and a missing member stay distinct, and that a cross-area tool needs
 * every area rather than any of them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_PERMISSION_AREAS,
  type AdminPermissionLevel,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

import { readFreshAdminPermissionMatrix } from "../../page-context/authorize";
import { authorizeDiagnosticsToolCall } from "../authorize";

vi.mock("../../page-context/authorize", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("../../page-context/authorize");
  return {
    // The AND/missing-area predicates stay REAL — mocking them would be mocking
    // the thing under test. Only the database read is stubbed.
    ...actual,
    readFreshAdminPermissionMatrix: vi.fn(),
  };
});

const readMock = vi.mocked(readFreshAdminPermissionMatrix);

function matrix(
  overrides: Partial<Record<keyof AdminPermissionMatrix, AdminPermissionLevel>> = {},
): AdminPermissionMatrix {
  const base = Object.fromEntries(
    ADMIN_PERMISSION_AREAS.map((area) => [area.key, "none"]),
  ) as AdminPermissionMatrix;
  return { ...base, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authorizeDiagnosticsToolCall (#2374, ADR-002 §2/§3)", () => {
  it("allows a caller holding view on the single required area", async () => {
    readMock.mockResolvedValue({ ok: true, matrix: matrix({ support: "view" }) });
    const result = await authorizeDiagnosticsToolCall({
      actingMemberId: "member-1",
      requiredAreas: ["support"],
    });
    expect(result.ok).toBe(true);
  });

  it("allows at `edit` too — `view` is a floor", async () => {
    readMock.mockResolvedValue({ ok: true, matrix: matrix({ support: "edit" }) });
    const result = await authorizeDiagnosticsToolCall({
      actingMemberId: "member-1",
      requiredAreas: ["support"],
    });
    expect(result.ok).toBe(true);
  });

  it("re-reads the roles on EVERY call — there is no memo", async () => {
    readMock.mockResolvedValue({ ok: true, matrix: matrix({ support: "view" }) });
    await authorizeDiagnosticsToolCall({
      actingMemberId: "member-1",
      requiredAreas: ["support"],
    });
    await authorizeDiagnosticsToolCall({
      actingMemberId: "member-1",
      requiredAreas: ["support"],
    });
    expect(readMock).toHaveBeenCalledTimes(2);
  });

  it("honours a role revoked between two calls in the same session", async () => {
    readMock
      .mockResolvedValueOnce({ ok: true, matrix: matrix({ support: "view" }) })
      .mockResolvedValueOnce({ ok: true, matrix: matrix() });

    const first = await authorizeDiagnosticsToolCall({
      actingMemberId: "member-1",
      requiredAreas: ["support"],
    });
    const second = await authorizeDiagnosticsToolCall({
      actingMemberId: "member-1",
      requiredAreas: ["support"],
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it("requires EVERY area of a cross-area tool, not any", async () => {
    readMock.mockResolvedValue({
      ok: true,
      matrix: matrix({ bookings: "view" }),
    });
    const result = await authorizeDiagnosticsToolCall({
      actingMemberId: "member-1",
      requiredAreas: ["bookings", "finance"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("permission_denied");
    expect(result.missingAreas).toEqual(["finance"]);
  });

  it("lists every missing area, in the tool's declared order", async () => {
    readMock.mockResolvedValue({ ok: true, matrix: matrix() });
    const result = await authorizeDiagnosticsToolCall({
      actingMemberId: "member-1",
      requiredAreas: ["bookings", "membership", "finance"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingAreas).toEqual(["bookings", "membership", "finance"]);
    }
  });

  it("DENIES a tool that declares no area at all", async () => {
    // A tool requiring nothing would be a tool anyone may run. The registry
    // contract forbids it; this refuses to implement it as a fallback.
    readMock.mockResolvedValue({ ok: true, matrix: matrix({ support: "edit" }) });
    const result = await authorizeDiagnosticsToolCall({
      actingMemberId: "member-1",
      requiredAreas: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("permission_denied");
  });

  // A TOTAL map, one reason per failure code — the same table AID-4's page context
  // holds. The ternary this replaced had a fallback, so `member_blocked` (an
  // administratively locked-out admin) was filed as `actor_read_failed`: the
  // reference guide defines that as a database fault, its operator sentence invites
  // a retry, and the same person's page-context fetch in the same conversation
  // recorded `actor_blocked`. One cause, two channels, two different verdicts.
  it.each([
    ["member_not_found", "actor_unresolved"],
    ["member_blocked", "actor_blocked"],
    ["read_failed", "actor_read_failed"],
  ] as const)("maps the %s failure to %s", async (failure, reason) => {
    readMock.mockResolvedValueOnce({ ok: false, failure });
    const result = await authorizeDiagnosticsToolCall({
      actingMemberId: "member-1",
      requiredAreas: ["support"],
    });
    expect(result).toEqual({ ok: false, reason, missingAreas: [] });
  });

  it("never reports a lock-out as a permission outcome", async () => {
    // `actor_blocked` is not a per-area verdict: there is no authorized actor at
    // all, so it must not carry missing areas the caller could reason about.
    readMock.mockResolvedValueOnce({ ok: false, failure: "member_blocked" });
    const result = await authorizeDiagnosticsToolCall({
      actingMemberId: "member-1",
      requiredAreas: ["bookings", "finance"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("actor_blocked");
      expect(result.missingAreas).toEqual([]);
    }
  });

  it("treats a THROWN reader as a read failure, not as a lock-out", async () => {
    readMock.mockRejectedValueOnce(new Error("prisma exploded"));
    const result = await authorizeDiagnosticsToolCall({
      actingMemberId: "member-1",
      requiredAreas: ["support"],
    });
    expect(result).toEqual({
      ok: false,
      reason: "actor_read_failed",
      missingAreas: [],
    });
  });
});
