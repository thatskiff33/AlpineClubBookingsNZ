import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import type { AgeTier } from "@prisma/client";
import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestProfileRequiredError,
  getBookingGuestValidationErrorResponse,
  type LinkedBookingMember,
} from "../booking-guests";

const confirmedAt = new Date("2026-05-10T00:00:00.000Z");

function readRepoFile(path: string) {
  return readFileSync(`${process.cwd()}/${path}`, "utf8");
}

const completeProfile = {
  firstName: "Sam",
  lastName: "Smith",
  phoneCountryCode: "64",
  phoneAreaCode: "27",
  phoneNumber: "4224115",
  dateOfBirth: new Date("2015-01-01T00:00:00.000Z"),
  streetAddressLine1: "1 Snow Road",
  streetCity: "Taupo",
  streetRegion: "Waikato",
  streetPostalCode: "3330",
  streetCountry: "NZ",
  postalAddressLine1: "1 Snow Road",
  postalCity: "Taupo",
  postalRegion: "Waikato",
  postalPostalCode: "3330",
  postalCountry: "NZ",
};

function member(overrides: Partial<LinkedBookingMember>): LinkedBookingMember {
  return {
    id: "guest-1",
    ageTier: "ADULT" as AgeTier,
    active: true,
    canLogin: false,
    role: "MEMBER",
    detailsConfirmedAt: confirmedAt,
    detailsConfirmedByMemberId: "adult-1",
    ...completeProfile,
    ...overrides,
  };
}

function linkedMap(...members: LinkedBookingMember[]) {
  return new Map(members.map((linkedMember) => [linkedMember.id, linkedMember]));
}

function mockDb() {
  return {
    familyGroupMember: {
      findMany: vi.fn().mockResolvedValue([
        { memberId: "adult-1", familyGroupId: "family-1" },
        { memberId: "guest-1", familyGroupId: "family-1" },
      ]),
    },
    member: {
      findMany: vi.fn().mockResolvedValue([
        { id: "adult-1", active: true, canLogin: true, ageTier: "ADULT" },
      ]),
    },
  };
}

function asBookingDb(db: ReturnType<typeof mockDb>) {
  return db as unknown as Parameters<typeof assertLinkedBookingMembersCanBeBooked>[0];
}

describe("assertLinkedBookingMembersCanBeBooked", () => {
  it("blocks incomplete linked member guests with the profile-required shape", async () => {
    const db = mockDb();
    const guest = member({ dateOfBirth: null });

    await expect(
      assertLinkedBookingMembersCanBeBooked(asBookingDb(db), linkedMap(guest), "adult-1")
    ).rejects.toBeInstanceOf(BookingGuestProfileRequiredError);

    try {
      await assertLinkedBookingMembersCanBeBooked(
        asBookingDb(db),
        linkedMap(guest),
        "adult-1"
      );
    } catch (error) {
      expect(error).toBeInstanceOf(BookingGuestProfileRequiredError);
      const body = getBookingGuestValidationErrorResponse(
        error as BookingGuestProfileRequiredError
      ) as {
        code: string;
        error: string;
        members: Array<{
          memberId: string;
          name: string;
          canCurrentUserResolve: boolean;
          needsOwnLoginConfirmation: boolean;
          missingFields: string[];
          action: string;
        }>;
      };
      expect(body).toMatchObject({
        code: "GUEST_PROFILE_REQUIRED",
        error: "Some member guests need their details completed or confirmed before booking.",
        members: [
          expect.objectContaining({
            memberId: "guest-1",
            name: "Sam Smith",
            canCurrentUserResolve: true,
            action: "complete_details",
          }),
        ],
      });
      expect(body.members[0].missingFields).toContain("Date of Birth");
    }
  });

  it("blocks unconfirmed linked member guests", async () => {
    const db = mockDb();
    const guest = member({
      detailsConfirmedAt: null,
      detailsConfirmedByMemberId: null,
    });

    await expect(
      assertLinkedBookingMembersCanBeBooked(asBookingDb(db), linkedMap(guest), "adult-1")
    ).rejects.toMatchObject({
      status: 403,
      code: "GUEST_PROFILE_REQUIRED",
    });
  });

  it("still blocks incomplete linked member guests for member-facing bookings", async () => {
    const db = mockDb();
    const guest = member({ dateOfBirth: null });

    await expect(
      assertLinkedBookingMembersCanBeBooked(
        asBookingDb(db),
        linkedMap(guest),
        "adult-1",
        { actorRole: "MEMBER" }
      )
    ).rejects.toMatchObject({
      status: 403,
      code: "GUEST_PROFILE_REQUIRED",
    });
  });

  it("allows admins booking on behalf to bypass the member-facing profile gate", async () => {
    const db = mockDb();
    const legacyGuest = member({
      dateOfBirth: null,
      detailsConfirmedAt: null,
      detailsConfirmedByMemberId: null,
    });

    await expect(
      assertLinkedBookingMembersCanBeBooked(
        asBookingDb(db),
        linkedMap(legacyGuest),
        "admin-1",
        { actorRole: "ADMIN", onBehalfOfMemberId: "target-member-1" }
      )
    ).resolves.toBeUndefined();
    expect(db.familyGroupMember.findMany).not.toHaveBeenCalled();
  });

  it("allows a login-capable member who confirmed their own details", async () => {
    const db = mockDb();
    const self = member({
      id: "adult-1",
      canLogin: true,
      detailsConfirmedByMemberId: "adult-1",
      ageTier: "ADULT" as AgeTier,
    });

    await expect(
      assertLinkedBookingMembersCanBeBooked(asBookingDb(db), linkedMap(self), "adult-1")
    ).resolves.toBeUndefined();
  });

  it("allows a confirmed non-login family member with a valid delegated confirmer", async () => {
    const db = mockDb();
    const child = member({
      id: "guest-1",
      canLogin: false,
      detailsConfirmedByMemberId: "adult-1",
      ageTier: "YOUTH" as AgeTier,
    });

    await expect(
      assertLinkedBookingMembersCanBeBooked(asBookingDb(db), linkedMap(child), "adult-1")
    ).resolves.toBeUndefined();
  });

  it("blocks a login-capable family member who has not confirmed themselves", async () => {
    const db = mockDb();
    const guest = member({
      id: "guest-1",
      canLogin: true,
      detailsConfirmedAt: confirmedAt,
      detailsConfirmedByMemberId: "adult-1",
    });

    try {
      await assertLinkedBookingMembersCanBeBooked(
        asBookingDb(db),
        linkedMap(guest),
        "adult-1"
      );
      throw new Error("Expected profile gate to block");
    } catch (error) {
      expect(error).toBeInstanceOf(BookingGuestProfileRequiredError);
      const body = getBookingGuestValidationErrorResponse(
        error as BookingGuestProfileRequiredError
      ) as {
        members: Array<{
          memberId: string;
          needsOwnLoginConfirmation: boolean;
          action: string;
        }>;
      };
      expect(body.members[0]).toMatchObject({
        memberId: "guest-1",
        needsOwnLoginConfirmation: true,
        action: "own_login_required",
      });
    }
  });

  it("does not block typed-in non-member guests because they have no linked member record", async () => {
    const db = mockDb();

    await expect(
      assertLinkedBookingMembersCanBeBooked(asBookingDb(db), new Map(), "adult-1")
    ).resolves.toBeUndefined();
    expect(db.familyGroupMember.findMany).not.toHaveBeenCalled();
  });
});

describe("booking profile gate route integration", () => {
  it("quote route uses the shared profile-required response shape", () => {
    const source = readRepoFile("src/app/api/bookings/quote/route.ts");

    expect(source).toContain("await assertLinkedBookingMembersCanBeBooked");
    expect(source).toContain("getBookingGuestValidationErrorResponse(error)");
  });

  it("create route validates linked member profiles before draft and waitlist paths", () => {
    const source = readRepoFile("src/app/api/bookings/route.ts");
    const gateIndex = source.indexOf("await assertLinkedBookingMembersCanBeBooked");

    expect(gateIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeLessThan(source.indexOf("if (draft) {"));
    expect(gateIndex).toBeLessThan(source.indexOf("createWaitlistedBooking({"));
    expect(source).toContain("getBookingGuestValidationErrorResponse(error)");
  });

  it("add-guests route validates linked member profiles before writing guests", () => {
    const source = readRepoFile("src/app/api/bookings/[id]/guests/route.ts");
    const gateIndex = source.indexOf("await assertLinkedBookingMembersCanBeBooked");
    const normalizeIndex = source.indexOf(
      "normalizedNewGuests = normalizeBookingGuestInputs",
      gateIndex
    );

    expect(gateIndex).toBeGreaterThan(-1);
    expect(normalizeIndex).toBeGreaterThan(gateIndex);
    expect(gateIndex).toBeLessThan(source.indexOf("tx.bookingGuest.create"));
    expect(source).toContain("getBookingGuestValidationErrorResponse(err)");
    expect(source).toContain("onBehalfOfMemberId:");
  });

  it("batch modify route validates linked member profiles before pricing and writing guests", () => {
    const source = readRepoFile("src/app/api/bookings/[id]/modify/route.ts");
    const gateIndex = source.indexOf("await assertLinkedBookingMembersCanBeBooked");
    const normalizeIndex = source.indexOf(
      "normalizeBookingGuestInputs(addGuests, linkedMembers)",
      gateIndex
    );

    expect(gateIndex).toBeGreaterThan(-1);
    expect(normalizeIndex).toBeGreaterThan(gateIndex);
    expect(gateIndex).toBeLessThan(source.indexOf("calculateBookingPrice(newCheckIn"));
    expect(gateIndex).toBeLessThan(source.indexOf("tx.bookingGuest.create"));
    expect(source).toContain("getBookingGuestValidationErrorResponse(err)");
    expect(source).toContain("onBehalfOfMemberId:");
  });

  it("modify quote route validates linked member profiles before pricing added guests", () => {
    const source = readRepoFile("src/app/api/bookings/[id]/modify-quote/route.ts");
    const gateIndex = source.indexOf("await assertLinkedBookingMembersCanBeBooked");
    const normalizeIndex = source.indexOf(
      "normalizeBookingGuestInputs(addGuests, linkedMembers)",
      gateIndex
    );

    expect(gateIndex).toBeGreaterThan(-1);
    expect(normalizeIndex).toBeGreaterThan(gateIndex);
    expect(gateIndex).toBeLessThan(source.indexOf("calculateBookingPrice("));
    expect(source).toContain("getBookingGuestValidationErrorResponse(error)");
    expect(source).toContain("onBehalfOfMemberId:");
  });
});
