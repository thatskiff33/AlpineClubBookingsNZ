import { describe, expect, it } from "vitest";
import {
  evaluateMemberProfileCompleteness,
  evaluateSelfServiceProfilePayload,
  isSelfServiceProfilePayloadComplete,
  type MemberProfileCompletenessInput,
} from "@/lib/member-profile-completeness";

const completeProfile = {
  firstName: "Alice",
  lastName: "Smith",
  phoneCountryCode: "64",
  phoneAreaCode: "27",
  phoneNumber: "4224115",
  dateOfBirth: new Date("1990-01-15T00:00:00.000Z"),
  streetAddressLine1: "123 Main St",
  streetAddressLine2: null,
  streetCity: "Tokoroa",
  streetRegion: "Waikato",
  streetPostalCode: "3420",
  streetCountry: "NZ",
  postalAddressLine1: "PO Box 42",
  postalAddressLine2: null,
  postalCity: "Tokoroa",
  postalRegion: "Waikato",
  postalPostalCode: "3420",
  postalCountry: "NZ",
};

describe("evaluateMemberProfileCompleteness", () => {
  it("marks a complete confirmed self profile as bookable", () => {
    const result = evaluateMemberProfileCompleteness({
      ...completeProfile,
      id: "member-1",
      canLogin: true,
      detailsConfirmedAt: new Date("2026-05-10T00:00:00.000Z"),
      detailsConfirmedByMemberId: "member-1",
    });

    expect(result).toMatchObject({
      isProfileComplete: true,
      isDetailsConfirmed: true,
      canBeBookedAsMember: true,
      missingFields: [],
      needsOwnLoginConfirmation: false,
      confirmationMode: "self",
    });
  });

  it("does not treat a login-capable member as confirmed by another member", () => {
    const result = evaluateMemberProfileCompleteness({
      ...completeProfile,
      id: "member-1",
      canLogin: true,
      detailsConfirmedAt: new Date("2026-05-10T00:00:00.000Z"),
      detailsConfirmedByMemberId: "member-2",
    });

    expect(result.isProfileComplete).toBe(true);
    expect(result.isDetailsConfirmed).toBe(false);
    expect(result.canBeBookedAsMember).toBe(false);
    expect(result.needsOwnLoginConfirmation).toBe(true);
  });

  it("reports missing self profile fields", () => {
    const result = evaluateMemberProfileCompleteness({
      canLogin: true,
      firstName: "Alice",
      lastName: " ",
    });

    expect(result.isProfileComplete).toBe(false);
    expect(result.missingFields).toEqual(
      expect.arrayContaining([
        "lastName",
        "phoneCountryCode",
        "phoneAreaCode",
        "phoneNumber",
        "dateOfBirth",
        "streetAddressLine1",
        "streetCity",
        "streetRegion",
        "streetPostalCode",
        "streetCountry",
        "postalAddressLine1",
        "postalCity",
        "postalRegion",
        "postalPostalCode",
        "postalCountry",
      ])
    );
  });

  it("allows a self-service payload to use postal same as physical", () => {
    const payload = {
      ...completeProfile,
      postalAddressLine1: null,
      postalCity: null,
      postalRegion: null,
      postalPostalCode: null,
      postalCountry: null,
      postalSameAsPhysical: true,
    };

    expect(evaluateSelfServiceProfilePayload(payload)).toEqual({
      isProfileComplete: true,
      missingFields: [],
    });
    expect(isSelfServiceProfilePayloadComplete(payload)).toBe(true);
  });

  it("requires delegated confirmation for non-login members", () => {
    const result = evaluateMemberProfileCompleteness({
      ...completeProfile,
      canLogin: false,
      detailsConfirmedAt: new Date("2026-05-10T00:00:00.000Z"),
      detailsConfirmedByMemberId: "adult1",
    });

    expect(result.confirmationMode).toBe("delegated");
    expect(result.isProfileComplete).toBe(true);
    expect(result.isDetailsConfirmed).toBe(true);
    expect(result.canBeBookedAsMember).toBe(true);
    expect(result.needsOwnLoginConfirmation).toBe(false);
  });

  it("keeps login-capable members on own confirmation until confirmed", () => {
    const member: MemberProfileCompletenessInput = {
      ...completeProfile,
      canLogin: true,
      profileCompletedAt: null,
      detailsConfirmedAt: null,
    };

    const result = evaluateMemberProfileCompleteness(member);

    expect(result.isProfileComplete).toBe(true);
    expect(result.isDetailsConfirmed).toBe(false);
    expect(result.canBeBookedAsMember).toBe(false);
    expect(result.needsOwnLoginConfirmation).toBe(true);
    expect(result.confirmationMode).toBe("self");
  });

  it("does not require self confirmation for admin or lodge login accounts", () => {
    for (const role of ["ADMIN", "LODGE"]) {
      const result = evaluateMemberProfileCompleteness({
        ...completeProfile,
        id: `${role.toLowerCase()}-1`,
        role,
        canLogin: true,
        detailsConfirmedAt: null,
        detailsConfirmedByMemberId: null,
      });

      expect(result.confirmationMode).toBe("not_allowed");
      expect(result.needsOwnLoginConfirmation).toBe(false);
      expect(result.canBeBookedAsMember).toBe(false);
    }
  });
});
