import { describe, it, expect, vi } from "vitest";
import { syncBookingOfficerForRole } from "@/lib/committee-booking-officer-sync";

// The sync accepts a narrow Prisma-shaped client, so we drive it with a hand-built
// fake instead of mocking the module. Each test wires the reads it needs and
// asserts on the otherLodge.update calls (the observable effect).

const MEMBER = {
  firstName: "Andy",
  lastName: "Schulz",
  phoneCountryCode: "64",
  phoneAreaCode: "27",
  phoneNumber: "4224115",
};

// The booking-officer email is the ROLE's shared contact address, not the
// member's personal email.
const ROLE_CONTACT_EMAIL = "bookings@club.test";

function makeDb(opts: {
  roles?: Array<{ id: string }>;
  holder?: {
    memberId: string;
    member: typeof MEMBER;
    showPhone?: boolean;
    committeeRole: { contactEmail: string | null };
  } | null;
  lodges?: Array<{ name: string }>;
  /** The stored owned list (#52): absent = no settings row = never told. */
  ownedNames?: unknown;
  otherLodges?: Array<{
    id: string;
    name?: string;
    bookingOfficerName: string | null;
    bookingOfficerEmail: string | null;
    bookingOfficerPhone: string | null;
  }>;
}) {
  const update = vi.fn().mockResolvedValue({});
  const db = {
    committeeRole: {
      findMany: vi.fn().mockResolvedValue(opts.roles ?? []),
    },
    committeeAssignment: {
      // `showPhone` defaults TRUE here so the pre-existing cases still exercise
      // the phone path; the withheld-phone case sets it false explicitly.
      findFirst: vi.fn().mockResolvedValue(
        opts.holder ? { showPhone: true, ...opts.holder } : null,
      ),
    },
    lodge: {
      findMany: vi.fn().mockResolvedValue(opts.lodges ?? []),
    },
    otherLodge: {
      // Deliberately NOT filtered by the `name: { in }` the sync asks with: the
      // write-time `ownsOtherLodge` check is the rule, and this fake hands every
      // row back so that check is what the owned-list cases prove, not the query.
      findMany: vi.fn().mockResolvedValue(opts.otherLodges ?? []),
      update,
    },
    serverNzSettings: {
      findUnique: vi.fn().mockResolvedValue(
        opts.ownedNames === undefined ? null : { otherLodgesOwnedNames: opts.ownedNames },
      ),
    },
  };
  return { db, update };
}

describe("syncBookingOfficerForRole", () => {
  it("does nothing for a role that is not the Booking Officer", async () => {
    const { db, update } = makeDb({ roles: [{ id: "role_bo" }] });
    const result = await syncBookingOfficerForRole(
      db as never,
      "role_president",
    );
    expect(result).toBeNull();
    expect(db.committeeAssignment.findFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("writes the holder's contact into the OtherLodge row matching the lodge name", async () => {
    const { db, update } = makeDb({
      roles: [{ id: "role_bo" }],
      holder: {
        memberId: "m1",
        member: MEMBER,
        committeeRole: { contactEmail: ROLE_CONTACT_EMAIL },
      },
      lodges: [{ name: "Whakapapa Lodge" }],
      otherLodges: [
        {
          id: "ol1",
          bookingOfficerName: null,
          bookingOfficerEmail: null,
          bookingOfficerPhone: null,
        },
      ],
    });

    const result = await syncBookingOfficerForRole(db as never, "role_bo");

    expect(result).toEqual({ updated: 1, holderMemberId: "m1" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({
      where: { id: "ol1" },
      data: {
        bookingOfficerName: "Andy Schulz",
        // Role's shared contact email, not the member's personal address.
        bookingOfficerEmail: ROLE_CONTACT_EMAIL,
        bookingOfficerPhone: "64 27 4224115",
      },
    });
  });

  it("skips a row whose contact already matches (no needless updatedAt bump)", async () => {
    const { db, update } = makeDb({
      roles: [{ id: "role_bo" }],
      holder: {
        memberId: "m1",
        member: MEMBER,
        committeeRole: { contactEmail: ROLE_CONTACT_EMAIL },
      },
      lodges: [{ name: "Whakapapa Lodge" }],
      otherLodges: [
        {
          id: "ol1",
          bookingOfficerName: "Andy Schulz",
          bookingOfficerEmail: ROLE_CONTACT_EMAIL,
          bookingOfficerPhone: "64 27 4224115",
        },
      ],
    });

    const result = await syncBookingOfficerForRole(db as never, "role_bo");
    expect(result).toEqual({ updated: 0, holderMemberId: "m1" });
    expect(update).not.toHaveBeenCalled();
  });

  it("clears the contact when the role has no active holder", async () => {
    const { db, update } = makeDb({
      roles: [{ id: "role_bo" }],
      holder: null,
      lodges: [{ name: "Whakapapa Lodge" }],
      otherLodges: [
        {
          id: "ol1",
          bookingOfficerName: "Andy Schulz",
          bookingOfficerEmail: "andy@example.com",
          bookingOfficerPhone: "64 27 4224115",
        },
      ],
    });

    const result = await syncBookingOfficerForRole(db as never, "role_bo");
    expect(result).toEqual({ updated: 1, holderMemberId: null });
    expect(update.mock.calls[0][0]).toMatchObject({
      where: { id: "ol1" },
      data: {
        bookingOfficerName: null,
        bookingOfficerEmail: null,
        bookingOfficerPhone: null,
      },
    });
  });

  it("matches the Booking Officer role by key or name fallback", async () => {
    // Role resolved via the OR(key, name) query; the affected id is included.
    const { db } = makeDb({
      roles: [{ id: "role_bo" }],
      holder: {
        memberId: "m1",
        member: MEMBER,
        committeeRole: { contactEmail: ROLE_CONTACT_EMAIL },
      },
      lodges: [{ name: "Whakapapa Lodge" }],
      otherLodges: [],
    });
    await syncBookingOfficerForRole(db as never, "role_bo");
    const where = db.committeeRole.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { key: "bookings" },
      { name: { equals: "Booking Officer", mode: "insensitive" } },
    ]);
  });
  // ---------------------------------------------------------------------------
  // Consent. This registry is redistributed to every connected club, so it must
  // never be broader than the club's own public committee page.
  // ---------------------------------------------------------------------------

  it("only ever considers a holder the club has already published", async () => {
    const { db } = makeDb({
      roles: [{ id: "role_bo" }],
      holder: {
        memberId: "m1",
        member: MEMBER,
        committeeRole: { contactEmail: ROLE_CONTACT_EMAIL },
      },
      lodges: [{ name: "Whakapapa Lodge" }],
      otherLodges: [],
    });

    await syncBookingOfficerForRole(db as never, "role_bo");

    // The fake ignores `where`, so the gate is asserted on the query itself —
    // the same four conditions `/api/committee` applies. `published`, `showPhone`
    // and `contactable` are all @default(false), so without `published` here a
    // brand-new assignment would be published nationally by default.
    const where = db.committeeAssignment.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      isActive: true,
      published: true,
      committeeRole: { isActive: true },
      member: { active: true },
    });
  });

  it("withholds the phone when the member did not consent to showing it", async () => {
    const { db, update } = makeDb({
      roles: [{ id: "role_bo" }],
      holder: {
        memberId: "m1",
        member: MEMBER,
        showPhone: false,
        committeeRole: { contactEmail: ROLE_CONTACT_EMAIL },
      },
      lodges: [{ name: "Whakapapa Lodge" }],
      otherLodges: [
        {
          id: "ol1",
          bookingOfficerName: null,
          bookingOfficerEmail: null,
          bookingOfficerPhone: null,
        },
      ],
    });

    await syncBookingOfficerForRole(db as never, "role_bo");

    // Name and the ROLE's shared email still travel — those are published. The
    // personal phone does not, because the club withheld it locally.
    expect(update.mock.calls[0][0].data).toEqual({
      bookingOfficerName: "Andy Schulz",
      bookingOfficerEmail: ROLE_CONTACT_EMAIL,
      bookingOfficerPhone: null,
    });
  });

  it("clears a previously published phone when consent is withdrawn", async () => {
    const { db, update } = makeDb({
      roles: [{ id: "role_bo" }],
      holder: {
        memberId: "m1",
        member: MEMBER,
        showPhone: false,
        committeeRole: { contactEmail: ROLE_CONTACT_EMAIL },
      },
      lodges: [{ name: "Whakapapa Lodge" }],
      otherLodges: [
        {
          id: "ol1",
          bookingOfficerName: "Andy Schulz",
          bookingOfficerEmail: ROLE_CONTACT_EMAIL,
          bookingOfficerPhone: "64 27 4224115",
        },
      ],
    });

    const result = await syncBookingOfficerForRole(db as never, "role_bo");

    // Turning showPhone off is a real change, so the row IS rewritten — the
    // number must actively leave the registry rather than merely stop refreshing.
    expect(result).toEqual({ updated: 1, holderMemberId: "m1" });
    expect(update.mock.calls[0][0].data.bookingOfficerPhone).toBeNull();
  });
});

// ── Which rows are ours (#52) ───────────────────────────────────────────────
//
// Once the central server has said which lodges this club owns, THAT list
// decides which registry rows take the officer's contact — through the same
// `ownsOtherLodge` rule as the admin edit route and the upload — and the
// building-name match is only the fallback for a site the server has not told.

describe("writes only the rows the central server says are ours (#52)", () => {
  const holder = {
    memberId: "m1",
    member: MEMBER,
    committeeRole: { contactEmail: ROLE_CONTACT_EMAIL },
  };
  const blank = { bookingOfficerName: null, bookingOfficerEmail: null, bookingOfficerPhone: null };

  it("writes the owned row and skips a row that merely shares a building's name", async () => {
    // The collision the name rule carried: this club's building "Whakapapa
    // Lodge" is also another club's registry row. With the owned list known,
    // only "Aorangi Ski Club" — the server's answer — is written.
    const { db, update } = makeDb({
      roles: [{ id: "role_bo" }],
      holder,
      lodges: [{ name: "Whakapapa Lodge" }],
      ownedNames: ["Aorangi Ski Club"],
      otherLodges: [
        { id: "theirs", name: "Whakapapa Lodge", ...blank },
        { id: "ours", name: "Aorangi Ski Club", ...blank },
      ],
    });

    const result = await syncBookingOfficerForRole(db as never, "role_bo");

    expect(result).toEqual({ updated: 1, holderMemberId: "m1" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].where).toEqual({ id: "ours" });
    // The building names were not even consulted.
    expect(db.lodge.findMany).not.toHaveBeenCalled();
    expect(db.otherLodge.findMany.mock.calls[0][0].where).toEqual({
      name: { in: ["Aorangi Ski Club"] },
    });
  });

  it("writes nothing when the server said the club owns no lodge", async () => {
    const { db, update } = makeDb({
      roles: [{ id: "role_bo" }],
      holder,
      lodges: [{ name: "Whakapapa Lodge" }],
      ownedNames: [],
      otherLodges: [{ id: "theirs", name: "Whakapapa Lodge", ...blank }],
    });

    const result = await syncBookingOfficerForRole(db as never, "role_bo");

    expect(result).toEqual({ updated: 0, holderMemberId: "m1" });
    expect(update).not.toHaveBeenCalled();
  });

  it("falls back to the building-name rule only while the server has not said", async () => {
    const { db, update } = makeDb({
      roles: [{ id: "role_bo" }],
      holder,
      lodges: [{ name: "Whakapapa Lodge" }],
      // No ownedNames: no settings row, never told.
      otherLodges: [{ id: "ol1", name: "Whakapapa Lodge", ...blank }],
    });

    const result = await syncBookingOfficerForRole(db as never, "role_bo");

    expect(result).toEqual({ updated: 1, holderMemberId: "m1" });
    expect(update.mock.calls[0][0].where).toEqual({ id: "ol1" });
  });

  it("writes nothing when the stored list is present but unreadable (fail closed)", async () => {
    const { db, update } = makeDb({
      roles: [{ id: "role_bo" }],
      holder,
      lodges: [{ name: "Whakapapa Lodge" }],
      ownedNames: "Aorangi Ski Club",
      otherLodges: [{ id: "ol1", name: "Whakapapa Lodge", ...blank }],
    });

    const result = await syncBookingOfficerForRole(db as never, "role_bo");

    expect(result).toEqual({ updated: 0, holderMemberId: "m1" });
    expect(update).not.toHaveBeenCalled();
    expect(db.lodge.findMany).not.toHaveBeenCalled();
    expect(db.otherLodge.findMany).not.toHaveBeenCalled();
  });
});
