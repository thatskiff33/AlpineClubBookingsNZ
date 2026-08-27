// Issue #1946: the member CSV import can create a member directly in the
// cancelled end-state via an optional Cancelled Date column. These tests
// exercise the POST /api/admin/members/import route to confirm the cancelled
// row is created inactive + non-login with cancelledAt set, that a cancelled
// row never claims the login for a shared email, that a future cancelled date
// is rejected, and that an existing member is skipped (never cancelled) so the
// import stays create-only.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    memberFieldsSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    memberAccessRole: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    passwordResetToken: { create: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    // CT-4 (#2870): "is this cancellation date in the future?" is asked against
    // the club's day, read from `ClubTimeSettings`. Without this delegate
    // `loadPersistedClubTimeSettings()` returns null -- fail-soft by design --
    // and the route falls back to the container's `TZ` in silence.
    clubTimeSettings: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01")),
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/email", () => ({ sendMemberSetupInviteEmail: vi.fn() }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("bcryptjs", () => ({ hash: vi.fn().mockResolvedValue("hashed") }));

import { prisma } from "@/lib/prisma";
import { sendMemberSetupInviteEmail } from "@/lib/email";
import { POST as importMembers } from "@/app/api/admin/members/import/route";
import {
  addDaysDateOnly,
  formatDateOnly,
  parseDateOnly,
  todayDateOnlyForTimeZone,
} from "@/lib/date-only";

const fullAdminGuard = {
  ok: true,
  session: { user: { id: "actor1", role: "ADMIN", accessRoles: ["ADMIN"] } },
};

type CreatedMemberData = Record<string, unknown>;
const createdMemberData: CreatedMemberData[] = [];

function mockCreateTransaction() {
  vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) =>
    fn({
      member: {
        create: vi.fn(async ({ data }: any) => {
          createdMemberData.push(data);
          return {
            id: `new-${createdMemberData.length}`,
            email: data.email,
            firstName: data.firstName,
            lastName: data.lastName,
            canLogin: data.canLogin,
          };
        }),
      },
      memberAccessRole: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    }),
  );
}

import { APP_TIME_ZONE } from "@/config/operational";

/**
 * The club this suite is about. The route reads the PERSISTED zone (CT-4,
 * #2870), so the fixtures below have to be built in the SAME zone -- deriving
 * "today" from `APP_TIME_ZONE` instead would agree only on a host that happens
 * to sit in New Zealand, and diverge silently anywhere else.
 */
const SUITE_CLUB_ZONE = "Pacific/Auckland";

/** Persist a club timezone for the route's `clubTime()` read to resolve. */
function persistClubZone(timeZone: string) {
  vi.mocked(prisma.clubTimeSettings.findUnique).mockResolvedValue({
    timeZone,
    updatedByMemberId: null,
    updatedAt: new Date(0),
  } as never);
}

function importRequest(body: Record<string, unknown>) {
  return importMembers(
    new NextRequest("http://localhost/api/admin/members/import", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("issue #1946 — importing cancelled members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createdMemberData.length = 0;
    mockRequireAdmin.mockResolvedValue(fullAdminGuard);
    vi.mocked(prisma.memberFieldsSettings.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.member.findMany).mockResolvedValue([]);
    persistClubZone(SUITE_CLUB_ZONE);
    mockCreateTransaction();
  });

  it("creates a member in the cancelled end-state when a cancelled date is given", async () => {
    const res = await importRequest({
      rows: [
        {
          firstName: "Cora",
          lastName: "Cancelled",
          email: "cora@example.com",
          cancelledDate: "2020-06-30",
        },
      ],
      sendInvites: true,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created).toBe(1);
    expect(data.createdCancelled).toBe(1);
    expect(data.createdLoginEnabled).toBe(0);
    expect(data.createdNonLogin).toBe(1);

    expect(createdMemberData).toHaveLength(1);
    const created = createdMemberData[0];
    expect(created.active).toBe(false);
    expect(created.canLogin).toBe(false);
    expect(created.cancelledAt).toBeInstanceOf(Date);
    expect((created.cancelledAt as Date).toISOString()).toBe(
      "2020-06-30T00:00:00.000Z",
    );
    // No cancellation request exists for a legacy import.
    expect(created.cancelledViaRequestId).toBeUndefined();

    // A cancelled member is never sent a setup invite, even with sendInvites.
    expect(vi.mocked(sendMemberSetupInviteEmail)).not.toHaveBeenCalled();
  });

  it("does not let a cancelled row claim the login for a shared email", async () => {
    const res = await importRequest({
      rows: [
        {
          firstName: "Cora",
          lastName: "Cancelled",
          email: "shared@example.com",
          cancelledDate: "2020-06-30",
        },
        {
          firstName: "Active",
          lastName: "Ann",
          email: "shared@example.com",
        },
      ],
      sendInvites: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created).toBe(2);
    expect(data.createdCancelled).toBe(1);
    // The active row keeps the login for the shared email.
    expect(data.createdLoginEnabled).toBe(1);

    const cancelled = createdMemberData.find(
      (row) => row.firstName === "Cora",
    );
    const active = createdMemberData.find((row) => row.firstName === "Active");
    expect(cancelled?.canLogin).toBe(false);
    expect(cancelled?.active).toBe(false);
    expect(active?.canLogin).toBe(true);
    expect(active?.active).toBe(true);
    expect(active?.cancelledAt).toBeNull();
  });

  it("rejects a future cancelled date and creates nobody", async () => {
    const res = await importRequest({
      rows: [
        {
          firstName: "Fred",
          lastName: "Future",
          email: "fred@example.com",
          cancelledDate: "2999-01-01",
        },
      ],
      sendInvites: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created).toBe(0);
    expect(data.errors).toHaveLength(1);
    expect(
      data.errors[0].errors.some((error: string) =>
        error.toLowerCase().includes("future"),
      ),
    ).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(createdMemberData).toHaveLength(0);
  });

  it("skips an existing member instead of cancelling them (create-only import)", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      {
        email: "existing@example.com",
        firstName: "Existing",
        lastName: "Member",
        dateOfBirth: null,
        canLogin: true,
      },
    ] as any);

    const res = await importRequest({
      rows: [
        {
          firstName: "Existing",
          lastName: "Member",
          email: "existing@example.com",
          cancelledDate: "2020-06-30",
        },
      ],
      sendInvites: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created).toBe(0);
    expect(data.skipped).toBe(1);
    // The existing member is untouched: no create, no cancellation write.
    expect(createdMemberData).toHaveLength(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // FIX-4: the shared-email login rule must be order-independent. The original
  // suite only covered cancelled-first; these cover active-first and the
  // multiple-actives case.
  it("keeps login on the active row when the active row comes first (active-first order)", async () => {
    const res = await importRequest({
      rows: [
        {
          firstName: "Active",
          lastName: "Ann",
          email: "shared@example.com",
        },
        {
          firstName: "Cora",
          lastName: "Cancelled",
          email: "shared@example.com",
          cancelledDate: "2020-06-30",
        },
      ],
      sendInvites: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created).toBe(2);
    expect(data.createdCancelled).toBe(1);
    expect(data.createdLoginEnabled).toBe(1);

    const active = createdMemberData.find((row) => row.firstName === "Active");
    const cancelled = createdMemberData.find((row) => row.firstName === "Cora");
    expect(active?.canLogin).toBe(true);
    expect(active?.active).toBe(true);
    expect(cancelled?.canLogin).toBe(false);
    expect(cancelled?.active).toBe(false);
  });

  it("gives login to only the first active row when multiple actives plus a cancelled share an email", async () => {
    const res = await importRequest({
      rows: [
        {
          firstName: "First",
          lastName: "Active",
          email: "shared@example.com",
        },
        {
          firstName: "Second",
          lastName: "Active",
          email: "shared@example.com",
        },
        {
          firstName: "Cora",
          lastName: "Cancelled",
          email: "shared@example.com",
          cancelledDate: "2020-06-30",
        },
      ],
      sendInvites: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created).toBe(3);
    expect(data.createdCancelled).toBe(1);
    // Exactly one login across the three shared-email rows.
    expect(data.createdLoginEnabled).toBe(1);

    const first = createdMemberData.find((row) => row.firstName === "First");
    const second = createdMemberData.find((row) => row.firstName === "Second");
    const cancelled = createdMemberData.find((row) => row.firstName === "Cora");
    expect(first?.canLogin).toBe(true);
    expect(second?.canLogin).toBe(false);
    expect(cancelled?.canLogin).toBe(false);
    expect(cancelled?.active).toBe(false);
  });

  // FIX-4: the per-field date format selected in the UI must reach the route's
  // cancelled-date parsing, not just the lib preview.
  it("threads the cancelledDate dateFormat through the route (dd/MM/yyyy)", async () => {
    const res = await importRequest({
      rows: [
        {
          firstName: "Dee",
          lastName: "Dateformat",
          email: "dee@example.com",
          cancelledDate: "15/01/2020",
        },
      ],
      dateFormats: { cancelledDate: "dd/MM/yyyy" },
      sendInvites: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created).toBe(1);
    expect(data.createdCancelled).toBe(1);
    expect(createdMemberData).toHaveLength(1);
    expect((createdMemberData[0].cancelledAt as Date).toISOString()).toBe(
      "2020-01-15T00:00:00.000Z",
    );
  });

  it("rejects the same value when the cancelledDate dateFormat is not threaded (default yyyy-MM-dd)", async () => {
    const res = await importRequest({
      rows: [
        {
          firstName: "Dee",
          lastName: "Dateformat",
          email: "dee@example.com",
          cancelledDate: "15/01/2020",
        },
      ],
      sendInvites: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created).toBe(0);
    expect(data.errors).toHaveLength(1);
    expect(createdMemberData).toHaveLength(0);
  });

  // FIX-4: today-boundary in the club time zone. Today is accepted (a
  // cancellation dated to now is legitimate); tomorrow is rejected as future.
  it("accepts a cancelledDate equal to NZ-today", async () => {
    // The CLUB's today, not the container's -- see `SUITE_CLUB_ZONE`.
    const today = todayDateOnlyForTimeZone(SUITE_CLUB_ZONE);
    const res = await importRequest({
      rows: [
        {
          firstName: "Tia",
          lastName: "Today",
          email: "tia@example.com",
          cancelledDate: today,
        },
      ],
      sendInvites: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created).toBe(1);
    expect(data.createdCancelled).toBe(1);
  });

  it("rejects a cancelledDate of NZ-tomorrow as a future date", async () => {
    const tomorrow = formatDateOnly(
      addDaysDateOnly(parseDateOnly(todayDateOnlyForTimeZone(SUITE_CLUB_ZONE)), 1),
    );
    const res = await importRequest({
      rows: [
        {
          firstName: "Tom",
          lastName: "Tomorrow",
          email: "tom@example.com",
          cancelledDate: tomorrow,
        },
      ],
      sendInvites: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created).toBe(0);
    expect(data.errors).toHaveLength(1);
    expect(
      data.errors[0].errors.some((error: string) =>
        error.toLowerCase().includes("future"),
      ),
    ).toBe(true);
    expect(createdMemberData).toHaveLength(0);
  });

  /*
    CT-4 (#2870), epic #2988 -- WHOSE today the future-date rule is measured
    against.

    The two cases above build their fixture in `SUITE_CLUB_ZONE`, which is the
    zone `beforeEach` persists AND the one the environment answers with, so they
    agree with the route whichever authority it consulted and could not notice a
    regression to the container's `TZ`. This one names an absolute date and
    persists a club zone the environment disagrees with.

    The frozen clock is 2026-07-01T00:00:00Z: midday on 1 July in New Zealand,
    still the evening of 30 JUNE in Denver. So 1 July is TODAY for the
    environment -- a date the rule accepts -- and TOMORROW for the club, which
    the rule must refuse. A member imported with a cancellation dated in their
    own club's future is a membership record that says someone stopped being a
    member before they did.
  */
  it("measures the future-date rule against the PERSISTED club day (CT-4, #2870)", async () => {
    persistClubZone("America/Denver");

    // The premise, measured as an ANSWER rather than as a zone identifier: two
    // zone names can still name the same day, and then this proves nothing.
    /*
     * `APP_TIME_ZONE` PASSED ON PURPOSE (#3123). Everywhere else in this file an
     * explicit zone exists to get OFF the environment; here the environment IS
     * the subject — the line measures what the environment authority answers so
     * it can prove the persisted zone answers differently. A literal zone name
     * would assert something about that name instead, and the premise would stop
     * tracking the environment it is guarding.
     */
    expect(
      todayDateOnlyForTimeZone(APP_TIME_ZONE),
      "INV-CONFIG-002: the environment authority now names the same day as the " +
        "persisted club zone, so this row cannot tell the two apart.",
    ).not.toBe("2026-06-30");

    const res = await importRequest({
      rows: [
        {
          firstName: "Dana",
          lastName: "Denver",
          email: "dana@example.com",
          cancelledDate: "2026-07-01",
        },
      ],
      sendInvites: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    // The environment would have called 1 July "today" and created the member.
    expect(data.created).toBe(0);
    expect(data.errors).toHaveLength(1);
    expect(
      data.errors[0].errors.some((error: string) =>
        error.toLowerCase().includes("future"),
      ),
    ).toBe(true);
    expect(createdMemberData).toHaveLength(0);
  });

  // FIX-4: an existing active DB member owns the login for an email; a NEW
  // cancelled row sharing that email must not claim the login (it is created
  // cancelled + non-login, and the existing member is untouched).
  it("cancelled row does not claim login when an existing active DB member owns the email", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      {
        email: "shared@example.com",
        firstName: "Existing",
        lastName: "Active",
        dateOfBirth: null,
        canLogin: true,
      },
    ] as any);

    const res = await importRequest({
      rows: [
        {
          firstName: "Cora",
          lastName: "Cancelled",
          email: "shared@example.com",
          cancelledDate: "2020-06-30",
        },
      ],
      sendInvites: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    // New identity (different name), so created — not skipped.
    expect(data.created).toBe(1);
    expect(data.createdCancelled).toBe(1);
    expect(data.createdLoginEnabled).toBe(0);
    const cancelled = createdMemberData.find((row) => row.firstName === "Cora");
    expect(cancelled?.canLogin).toBe(false);
    expect(cancelled?.active).toBe(false);
  });

  // FIX-3: a first-wins duplicate skip must tell the admin when the dropped row
  // carried a different lifecycle state, in both orders.
  it("notes the lifecycle mismatch when an active row is kept and a cancelled duplicate is skipped", async () => {
    const res = await importRequest({
      rows: [
        {
          firstName: "Dup",
          lastName: "Licate",
          email: "dup@example.com",
        },
        {
          firstName: "Dup",
          lastName: "Licate",
          email: "dup@example.com",
          cancelledDate: "2020-06-30",
        },
      ],
      sendInvites: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created).toBe(1);
    expect(data.skipped).toBe(1);
    const reason = data.skippedRows[0].reason as string;
    expect(reason).toContain("Duplicate member identity");
    expect(reason).toContain("kept row is active");
    expect(reason).toContain("this skipped row is cancelled");
  });

  it("notes the lifecycle mismatch when a cancelled row is kept and an active duplicate is skipped", async () => {
    const res = await importRequest({
      rows: [
        {
          firstName: "Dup",
          lastName: "Licate",
          email: "dup@example.com",
          cancelledDate: "2020-06-30",
        },
        {
          firstName: "Dup",
          lastName: "Licate",
          email: "dup@example.com",
        },
      ],
      sendInvites: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created).toBe(1);
    expect(data.skipped).toBe(1);
    const reason = data.skippedRows[0].reason as string;
    expect(reason).toContain("Duplicate member identity");
    expect(reason).toContain("kept row is cancelled");
    expect(reason).toContain("this skipped row is active");
  });

  it("does not add a lifecycle note when duplicates share the same cancelled state", async () => {
    const res = await importRequest({
      rows: [
        {
          firstName: "Dup",
          lastName: "Licate",
          email: "dup@example.com",
        },
        {
          firstName: "Dup",
          lastName: "Licate",
          email: "dup@example.com",
        },
      ],
      sendInvites: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.skipped).toBe(1);
    const reason = data.skippedRows[0].reason as string;
    expect(reason).toBe(
      "Duplicate member identity already appears earlier in this import",
    );
  });
});
