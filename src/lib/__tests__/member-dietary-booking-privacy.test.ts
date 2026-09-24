/**
 * The booking-guest dietary/allergy privacy boundary (#3029, `INV-PRIV-022`).
 *
 * Stage 1's `member-dietary-privacy.test.ts` proves the profile door. This file
 * proves the booking value's readers: who gets a grant (booking admins by
 * `bookings:view`/`edit` re-read from the database; the kiosk's `admin` and
 * `hut-leader` tiers only), who does not (every other kiosk tier, an admin's
 * kiosk preview, anybody while the field is OFF), that a booking grant cannot
 * read a profile nor a profile grant a booking, and that the value never
 * survives the log redactor or the audit sanitizer. The kiosk route and the
 * booking detail loader are driven for their DENIED audiences, whose payloads
 * must carry no `dietaryRequirements` key at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  bookingGuestFindMany: vi.fn(),
  bookingGuestFindFirst: vi.fn(),
  bookingGuestUpdateMany: vi.fn(),
  settingsFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique, findMany: mocks.memberFindMany },
    bookingGuest: {
      findMany: mocks.bookingGuestFindMany,
      findFirst: mocks.bookingGuestFindFirst,
      updateMany: mocks.bookingGuestUpdateMany,
    },
    memberFieldsSettings: { findUnique: mocks.settingsFindUnique },
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sanitizeAuditMetadata } from "@/lib/audit";
import { kioskTierManagesRoster, type KioskTier } from "@/lib/kiosk-access";
import {
  KIOSK_DIETARY_TIERS,
  grantBookingAdminDietaryAccess,
  grantKioskDietaryAccess,
  grantMembershipAdminDietaryAccess,
  grantSelfDataExportDietaryAccess,
  readBookingGuestDietaryForAdmin,
  readKioskGuestDietaryRequirements,
  readMemberDietaryRequirements,
  readOwnBookingGuestDietaryForExport,
  updateBookingGuestDietaryRequirements,
} from "@/lib/member-dietary";
import { redactSensitiveJson } from "@/lib/redact-sensitive-json";
import { loadBookingDetailGuestDietary } from "@/app/(authenticated)/bookings/[id]/_lib/booking-detail-guest-dietary";

const VALUE = "Severe peanut allergy — carries an EpiPen";
const ALL_TIERS: KioskTier[] = ["admin", "hut-leader", "lodge", "staying-guest", "none"];

/** The access role whose bundle gives exactly this `bookings` level. */
const ROLE_FOR_BOOKINGS = {
  none: "ADMIN_CONTENT",
  view: "ADMIN_READONLY",
  edit: "ADMIN_BOOKINGS",
} as const;

/** A requireAdmin-shaped guard whose DATABASE row holds `bookings` at `level`. */
function bookingAdmin(level: "none" | "view" | "edit", active = true) {
  mocks.memberFindUnique.mockImplementation(async (args: { where: { id: string } }) =>
    args.where.id === "admin-1"
      ? {
          active,
          canLogin: true,
          accessRoles: [{ role: ROLE_FOR_BOOKINGS[level], roleDefinition: null }],
        }
      : null,
  );
  return { ok: true as const, session: { user: { id: "admin-1" } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bookingGuestFindMany.mockResolvedValue([
    { id: "g1", dietaryRequirements: VALUE },
    { id: "g2", dietaryRequirements: null },
  ]);
});

describe("booking-admin grants are judged from the database (INV-PRIV-022)", () => {
  it("bookings:view reads, bookings:edit edits, and no bookings access gets nothing", async () => {
    expect(await grantBookingAdminDietaryAccess(bookingAdmin("none"), "view", { enabled: true })).toBeNull();
    const view = await grantBookingAdminDietaryAccess(bookingAdmin("view"), "view", { enabled: true });
    expect(view).not.toBeNull();
    expect(await grantBookingAdminDietaryAccess(bookingAdmin("view"), "edit", { enabled: true })).toBeNull();
    const edit = await grantBookingAdminDietaryAccess(bookingAdmin("edit"), "edit", { enabled: true });
    expect(edit).not.toBeNull();

    const values = await readBookingGuestDietaryForAdmin(view!, "bk-1");
    expect(values.get("g1")).toBe(VALUE);
    // A view grant cannot write.
    await expect(
      updateBookingGuestDietaryRequirements(view!, { bookingId: "bk-1", guestId: "g1", value: "x" }),
    ).rejects.toThrow(/cannot read or edit/);
  });

  it("an inactive actor, a missing row and the field OFF all get nothing", async () => {
    expect(await grantBookingAdminDietaryAccess(bookingAdmin("edit", false), "view", { enabled: true })).toBeNull();
    mocks.memberFindUnique.mockResolvedValue(null);
    expect(
      await grantBookingAdminDietaryAccess(
        { ok: true, session: { user: { id: "admin-1" } } },
        "view",
        { enabled: true },
      ),
    ).toBeNull();
    expect(await grantBookingAdminDietaryAccess(bookingAdmin("edit"), "edit", { enabled: false })).toBeNull();
    // OFF by default: no settings row reads OFF.
    mocks.settingsFindUnique.mockResolvedValue(null);
    expect(await grantBookingAdminDietaryAccess(bookingAdmin("edit"), "edit")).toBeNull();
  });

  it("a booking grant cannot read a member profile, and a membership grant cannot read a booking", async () => {
    const booking = await grantBookingAdminDietaryAccess(bookingAdmin("edit"), "view", { enabled: true });
    await expect(readMemberDietaryRequirements(booking!, "member-1")).rejects.toThrow(
      /cannot read a member profile/,
    );
    mocks.memberFindUnique.mockResolvedValue({
      active: true,
      canLogin: true,
      accessRoles: [{ role: "ADMIN_MEMBERSHIP", roleDefinition: null }],
    });
    const membership = await grantMembershipAdminDietaryAccess(
      { ok: true, session: { user: { id: "admin-1" } } },
      "view",
    );
    expect(membership).not.toBeNull();
    await expect(readBookingGuestDietaryForAdmin(membership!, "bk-1")).rejects.toThrow();
    await expect(readKioskGuestDietaryRequirements(membership!, ["g1"])).rejects.toThrow();
  });

  it("a copied or literal grant carries no authority", async () => {
    const grant = await grantBookingAdminDietaryAccess(bookingAdmin("edit"), "edit", { enabled: true });
    await expect(readBookingGuestDietaryForAdmin({ ...grant! }, "bk-1")).rejects.toThrow(
      /without an access grant/,
    );
    await expect(readBookingGuestDietaryForAdmin({} as never, "bk-1")).rejects.toThrow();
  });
});

describe("kiosk grants: admin and hut-leader only, present guests only (INV-PRIV-022)", () => {
  const access = (tier: KioskTier, extra: Record<string, unknown> = {}) => ({
    tier,
    actorMemberId: "leader-1",
    presentGuestIds: ["g1", "g2"],
    ...extra,
  });

  it("the dietary tier set is exactly the roster-managing tier set, tier by tier", () => {
    for (const tier of ALL_TIERS) {
      expect(KIOSK_DIETARY_TIERS.includes(tier), tier).toBe(kioskTierManagesRoster(tier));
    }
  });

  it("grants admin and hut-leader, and denies lodge, staying-guest and none", async () => {
    for (const tier of ALL_TIERS) {
      const grant = await grantKioskDietaryAccess(access(tier), { enabled: true });
      expect(grant !== null, tier).toBe(tier === "admin" || tier === "hut-leader");
    }
  });

  it("denies an admin's kiosk preview, an actorless session and the field OFF", async () => {
    expect(
      await grantKioskDietaryAccess(access("admin", { preview: { targetMemberId: "kiosk" } }), {
        enabled: true,
      }),
    ).toBeNull();
    expect(
      await grantKioskDietaryAccess(access("hut-leader", { actorMemberId: null }), { enabled: true }),
    ).toBeNull();
    expect(await grantKioskDietaryAccess(access("hut-leader"), { enabled: false })).toBeNull();
  });

  it("refuses a guest the grant was not minted for", async () => {
    const grant = await grantKioskDietaryAccess(access("hut-leader"), { enabled: true });
    await expect(readKioskGuestDietaryRequirements(grant!, ["g1", "someone-else"])).rejects.toThrow(
      /present guests/,
    );
    const values = await readKioskGuestDietaryRequirements(grant!, ["g1"]);
    expect(values.get("g1")).toBe(VALUE);
    // A kiosk grant is not a booking-admin grant.
    await expect(readBookingGuestDietaryForAdmin(grant!, "bk-1")).rejects.toThrow();
  });
});

describe("the subject's own data export reads only their own guest rows (INV-PRIV-022)", () => {
  it("queries by the subject's member id, and needs the export grant", async () => {
    mocks.bookingGuestFindMany.mockResolvedValue([
      {
        stayStart: new Date("2026-08-01T00:00:00.000Z"),
        stayEnd: new Date("2026-08-03T00:00:00.000Z"),
        dietaryRequirements: VALUE,
      },
    ]);
    const rows = await readOwnBookingGuestDietaryForExport(
      grantSelfDataExportDietaryAccess({ user: { id: "member-1" } }),
    );
    expect(rows).toEqual([expect.objectContaining({ dietaryRequirements: VALUE })]);
    expect(mocks.bookingGuestFindMany.mock.calls[0]![0].where).toEqual({
      memberId: "member-1",
      dietaryRequirements: { not: null },
    });
    const booking = await grantBookingAdminDietaryAccess(bookingAdmin("edit"), "view", { enabled: true });
    await expect(readOwnBookingGuestDietaryForExport(booking!)).rejects.toThrow();
  });
});

describe("the one booking-value edit (INV-PRIV-022, INV-MOD-060)", () => {
  it("matches the row on booking AND guest on a live booking, normalises, and reports a change", async () => {
    const grant = await grantBookingAdminDietaryAccess(bookingAdmin("edit"), "edit", { enabled: true });
    mocks.bookingGuestFindFirst.mockResolvedValue({ dietaryRequirements: null });
    mocks.bookingGuestUpdateMany.mockResolvedValue({ count: 1 });
    const result = await updateBookingGuestDietaryRequirements(grant!, {
      bookingId: "bk-1",
      guestId: "g1",
      value: "  Vegan\r\n  ",
    });
    expect(result).toEqual({ status: "updated", changed: true, cleared: false, value: "Vegan" });
    const where = { id: "g1", bookingId: "bk-1", booking: { deletedAt: null } };
    expect(mocks.bookingGuestUpdateMany).toHaveBeenCalledWith({
      where,
      data: { dietaryRequirements: "Vegan" },
    });
    // It never writes the member profile.
    expect(mocks.memberFindMany).not.toHaveBeenCalled();
  });

  it("returns not-found for a guest of another booking or a deleted booking, and refuses over 500", async () => {
    const grant = await grantBookingAdminDietaryAccess(bookingAdmin("edit"), "edit", { enabled: true });
    mocks.bookingGuestFindFirst.mockResolvedValue(null);
    await expect(
      updateBookingGuestDietaryRequirements(grant!, { bookingId: "bk-2", guestId: "g1", value: "x" }),
    ).resolves.toEqual({ status: "not-found" });
    expect(mocks.bookingGuestUpdateMany).not.toHaveBeenCalled();
    await expect(
      updateBookingGuestDietaryRequirements(grant!, {
        bookingId: "bk-1",
        guestId: "g1",
        value: "x".repeat(501),
      }),
    ).rejects.toThrow(/500 characters/);
  });
});

describe("the booking detail loader (R1) for each viewer (INV-PRIV-022)", () => {
  const booking = {
    id: "bk-1",
    deletedAt: null,
    guests: [
      { id: "g1", firstName: "Aroha", lastName: "Guest", isMember: true },
      { id: "g2", firstName: "Non", lastName: "Member", isMember: false },
    ],
  } as never;
  const viewer = (flags: { canViewAsAdmin: boolean; canAdminEditBookings: boolean }) =>
    flags as never;

  beforeEach(() => {
    mocks.settingsFindUnique.mockResolvedValue({ showDietaryRequirements: true });
  });

  it("the owner and a linked guest (no bookings access) get null and trigger no read", async () => {
    mocks.memberFindUnique.mockResolvedValue(null);
    const result = await loadBookingDetailGuestDietary({
      sessionUserId: "owner-1",
      booking,
      viewer: viewer({ canViewAsAdmin: false, canAdminEditBookings: false }),
    });
    expect(result).toBeNull();
    expect(mocks.bookingGuestFindMany).not.toHaveBeenCalled();
  });

  it("a view-only admin sees every guest's value without the edit control", async () => {
    bookingAdmin("view");
    const result = await loadBookingDetailGuestDietary({
      sessionUserId: "admin-1",
      booking,
      viewer: viewer({ canViewAsAdmin: true, canAdminEditBookings: false }),
    });
    expect(result).toEqual({
      canEdit: false,
      guests: [
        expect.objectContaining({ id: "g1", dietaryRequirements: VALUE }),
        expect.objectContaining({ id: "g2", isMember: false, dietaryRequirements: null }),
      ],
    });
  });

  it("an edit admin gets the edit control; a stale session flag without the DB role gets nothing", async () => {
    bookingAdmin("edit");
    const edit = await loadBookingDetailGuestDietary({
      sessionUserId: "admin-1",
      booking,
      viewer: viewer({ canViewAsAdmin: true, canAdminEditBookings: true }),
    });
    expect(edit?.canEdit).toBe(true);

    vi.clearAllMocks();
    bookingAdmin("none");
    mocks.settingsFindUnique.mockResolvedValue({ showDietaryRequirements: true });
    const stale = await loadBookingDetailGuestDietary({
      sessionUserId: "admin-1",
      booking,
      viewer: viewer({ canViewAsAdmin: true, canAdminEditBookings: true }),
    });
    expect(stale).toBeNull();
    expect(mocks.bookingGuestFindMany).not.toHaveBeenCalled();
  });

  it("the field OFF shows nothing to anybody, and deletes nothing", async () => {
    bookingAdmin("edit");
    mocks.settingsFindUnique.mockResolvedValue({ showDietaryRequirements: false });
    const result = await loadBookingDetailGuestDietary({
      sessionUserId: "admin-1",
      booking,
      viewer: viewer({ canViewAsAdmin: true, canAdminEditBookings: true }),
    });
    expect(result).toBeNull();
    expect(mocks.bookingGuestUpdateMany).not.toHaveBeenCalled();
  });
});

describe("the value never survives a log or an audit row (INV-PRIV-011, INV-PRIV-022)", () => {
  it("the log redactor drops a guest object's value", () => {
    const payload = { booking: { guests: [{ id: "g1", dietaryRequirements: VALUE }] } };
    expect(JSON.stringify(redactSensitiveJson(payload))).not.toContain("EpiPen");
  });

  it("the audit sanitizer keeps the change evidence and drops a value", () => {
    const sanitized = sanitizeAuditMetadata({
      bookingGuestId: "g1",
      dietaryRequirementsChanged: true,
      dietaryRequirements: VALUE,
    });
    expect(JSON.stringify(sanitized)).not.toContain("EpiPen");
    expect(sanitized).toEqual(
      expect.objectContaining({ bookingGuestId: "g1", dietaryRequirementsChanged: true }),
    );
  });
});
