import { describe, expect, it } from "vitest";
import { shouldShowMemberOnboarding, type MemberOnboardingProfile } from "@/lib/member-onboarding";
import {
  MEMBER_LEVEL_ROLE_VALUES,
  NON_MEMBER_ROLE_VALUES,
  OPERATIONAL_ROLE_VALUES,
  ROLE_VALUES,
  canAdminRequestMembershipCancellation,
  isMemberLevelRole,
  isMembershipCancellationBlockedByAdminRole,
  isOperationalRole,
} from "@/lib/member-roles";
import { effectiveSubscriptionBehavior } from "@/lib/membership-types";

function onboardingProfile(role: string): MemberOnboardingProfile {
  const accessRoles = ["USER", "ADMIN", "LODGE"].includes(role)
    ? [{ role }]
    : [];

  return {
    id: `member-${role.toLowerCase()}`,
    active: true,
    canLogin: true,
    role,
    accessRoles,
    forcePasswordChange: false,
    firstName: "Taylor",
    lastName: "Member",
    email: "taylor@example.org",
    phoneCountryCode: "",
    phoneAreaCode: "",
    phoneNumber: "",
    dateOfBirth: null,
    streetAddressLine1: "",
    streetCity: "",
    streetRegion: "",
    streetPostalCode: "",
    streetCountry: "",
    postalAddressLine1: "",
    postalCity: "",
    postalRegion: "",
    postalPostalCode: "",
    postalCountry: "",
    profileCompletedAt: null,
    detailsConfirmedAt: null,
    detailsConfirmedByMemberId: null,
    onboardingConfirmedAt: null,
  };
}

describe("member role categories", () => {
  it("treats USER as the ordinary member-facing access role", () => {
    expect(MEMBER_LEVEL_ROLE_VALUES).toEqual(["USER"]);
    expect(isMemberLevelRole("USER")).toBe(true);
    expect(isMemberLevelRole("MEMBER")).toBe(false);
    expect(isMemberLevelRole("ASSOCIATE")).toBe(false);
    expect(isMemberLevelRole("LIFE")).toBe(false);
    expect(isMemberLevelRole("ADMIN")).toBe(false);
    expect(isMemberLevelRole("LODGE")).toBe(false);
  });

  it("keeps only ADMIN and LODGE as operational roles", () => {
    expect(OPERATIONAL_ROLE_VALUES).toEqual(["ADMIN", "LODGE"]);
    expect(isOperationalRole("ADMIN")).toBe(true);
    expect(isOperationalRole("LODGE")).toBe(true);
    // #2149: role carries no exemption of its own — operational accounts are
    // exempt only because they resolve to a NOT_REQUIRED built-in type, while
    // USER resolves to FULL (REQUIRED).
    expect(effectiveSubscriptionBehavior(null, "ADMIN")).toBe("NOT_REQUIRED");
    expect(effectiveSubscriptionBehavior(null, "LODGE")).toBe("NOT_REQUIRED");
    expect(effectiveSubscriptionBehavior(null, "USER")).toBe("REQUIRED");
  });

  it("runs onboarding for users but not membership type category strings", () => {
    expect(shouldShowMemberOnboarding(onboardingProfile("USER"))).toBe(true);
    expect(shouldShowMemberOnboarding(onboardingProfile("ASSOCIATE"))).toBe(false);
    expect(shouldShowMemberOnboarding(onboardingProfile("LIFE"))).toBe(false);
    expect(shouldShowMemberOnboarding(onboardingProfile("ADMIN"))).toBe(false);
    expect(shouldShowMemberOnboarding(onboardingProfile("LODGE"))).toBe(false);
  });
});

describe("non-member booking-request roles", () => {

  it("grants them no member-level or operational access", () => {
    for (const role of NON_MEMBER_ROLE_VALUES) {
      expect(isMemberLevelRole(role)).toBe(false);
      expect(isOperationalRole(role)).toBe(false);
      // Non-login records, so onboarding never applies even before the role check.
      expect(shouldShowMemberOnboarding(onboardingProfile(role))).toBe(false);
    }
  });

  it("exempts them from membership subscriptions via their default type", () => {
    // #2149: exemption flows from the NON_MEMBER/SCHOOL built-in NOT_REQUIRED
    // types, not from the login role.
    expect(effectiveSubscriptionBehavior(null, "NON_MEMBER")).toBe(
      "NOT_REQUIRED",
    );
    expect(effectiveSubscriptionBehavior(null, "SCHOOL")).toBe("NOT_REQUIRED");
  });
});

describe("admin membership-cancellation eligibility", () => {
  const base = {
    role: "USER",
    active: true,
    cancelledAt: null,
    archivedAt: null,
  };

  it("offers cancellation for a dependant / non-login adult", () => {
    // The regression: the page gated on hasAccessRole(member, "USER"), which
    // is always false once canLogin is false (access roles are cleared for
    // anyone who cannot log in), hiding the action for every dependant while
    // the API accepted them. The extra fields here are the ones the old gate
    // consulted — carried deliberately to document that eligibility ignores
    // them. See membership-cancellation-gate-contract.test.ts for the call
    // site, which is what a revert would break.
    expect(
      canAdminRequestMembershipCancellation({
        ...base,
        canLogin: false,
        accessRoles: [],
      } as typeof base),
    ).toBe(true);
    expect(canAdminRequestMembershipCancellation(base)).toBe(true);
  });

  it("refuses non-member-level roles", () => {
    for (const role of [
      "ADMIN",
      "LODGE",
      "NON_MEMBER",
      "SCHOOL",
      null,
      undefined,
    ]) {
      expect(canAdminRequestMembershipCancellation({ ...base, role })).toBe(
        false,
      );
    }
  });

  it("refuses inactive, already-cancelled, and archived members", () => {
    expect(
      canAdminRequestMembershipCancellation({ ...base, active: false }),
    ).toBe(false);
    expect(
      canAdminRequestMembershipCancellation({
        ...base,
        cancelledAt: new Date(),
      }),
    ).toBe(false);
    expect(
      canAdminRequestMembershipCancellation({
        ...base,
        archivedAt: new Date(),
      }),
    ).toBe(false);
  });
});

describe("membership cancellation blocked by the ADMIN role (#2356)", () => {
  const base = {
    role: "ADMIN",
    active: true,
    cancelledAt: null,
    archivedAt: null,
  };

  it("explains the ADMIN case, which is a real person's account", () => {
    expect(isMembershipCancellationBlockedByAdminRole(base)).toBe(true);
    // The two predicates partition the eligible states: exactly one of them is
    // true for any given active member, never both.
    expect(canAdminRequestMembershipCancellation(base)).toBe(false);
  });

  it("stays silent for every role that is not a person holding admin access", () => {
    // LODGE is the shared kiosk device, SCHOOL/NON_MEMBER are the
    // booking-request organisation and guest records: no membership to
    // cancel, so "cannot be cancelled" would be noise. USER is the working
    // case and gets the action, not an explanation.
    for (const role of ["USER", "LODGE", "SCHOOL", "NON_MEMBER", null, undefined]) {
      expect(
        isMembershipCancellationBlockedByAdminRole({ ...base, role }),
      ).toBe(false);
    }
    // Belt and braces over the role vocabulary itself: ADMIN is the only value
    // in ROLE_VALUES that gets the explanation, so adding a role cannot widen
    // it silently.
    expect(
      ROLE_VALUES.filter((role) =>
        isMembershipCancellationBlockedByAdminRole({ ...base, role }),
      ),
    ).toEqual(["ADMIN"]);
  });

  it("stays silent once the membership is inactive, cancelled, or archived", () => {
    // Those states have their own explanation on the card, and the block is
    // only ever about the role standing in the way of an otherwise-live
    // membership.
    expect(
      isMembershipCancellationBlockedByAdminRole({ ...base, active: false }),
    ).toBe(false);
    expect(
      isMembershipCancellationBlockedByAdminRole({
        ...base,
        cancelledAt: new Date(),
      }),
    ).toBe(false);
    expect(
      isMembershipCancellationBlockedByAdminRole({
        ...base,
        archivedAt: new Date(),
      }),
    ).toBe(false);
  });
});
