/**
 * THE ACCESSOR'S OWN BEHAVIOUR (#3369, stage 4 of programme #2912).
 *
 * The census beside this file proves that every reader goes THROUGH
 * `bookingOwner()`. This one proves what they get when they do — which is the
 * other half, and the half that stage 4 changed. Several hundred call sites
 * were left untouched on the strength of one claim: that a school projected
 * into person shape renders the same bytes the invented school member rendered.
 * That claim is asserted here rather than believed.
 */
import { describe, expect, it } from "vitest";

import {
  BookingOwnerMissingError,
  bookingOwner,
  bookingOwnerAgeTier,
  bookingOwnerEmail,
  bookingOwnerHasNoAgeTier,
  bookingOwnerProviderMetadata,
} from "@/lib/booking-owner";

const MEMBER = {
  id: "member-1",
  firstName: "Ada",
  lastName: "Ngata",
  email: "ada@example.test",
  ageTier: "ADULT" as const,
};

const SCHOOL = { name: "Tokoroa Primary School", email: "office@tps.test" };

describe("#3369: a member-owned booking is handed back unchanged", () => {
  it("returns the member row BY REFERENCE, not a copy", () => {
    // The property the stage-3 sweep rested on: for a booking that has a
    // member, the accessor is still the identity it was, so nothing about the
    // existing three hundred call sites can have changed behaviour.
    const booking = { memberId: MEMBER.id, member: MEMBER, organisation: null };
    expect(bookingOwner(booking).member).toBe(MEMBER);
    expect(bookingOwner(booking).memberId).toBe("member-1");
  });

  it("keeps every selected column present, including the member-only ones", () => {
    const booking = { memberId: MEMBER.id, member: MEMBER, organisation: null };
    const owner = bookingOwner(booking).member;
    expect(owner.id).toBe("member-1");
    expect(owner.ageTier).toBe("ADULT");
  });
});

describe("#3369: an organisation-owned booking is projected into person shape", () => {
  const booking = {
    memberId: null,
    member: null as typeof MEMBER | null,
    organisationId: "org-1",
    organisation: SCHOOL,
  };

  it("renders the same bytes the invented school member rendered", () => {
    // The invented member carried the school's name in `firstName`, an empty
    // `lastName` and the request's contact address. That is exactly this.
    const owner = bookingOwner(booking).member;
    expect(owner.firstName).toBe("Tokoroa Primary School");
    expect(owner.lastName).toBe("");
    expect(owner.email).toBe("office@tps.test");
    expect(`${owner.firstName} ${owner.lastName}`.trim()).toBe(
      "Tokoroa Primary School",
    );
  });

  it("hands out NO member id, because an organisation is not a member", () => {
    expect(bookingOwner(booking).memberId).toBeNull();
    expect(bookingOwner(booking).member.id).toBeUndefined();
  });

  it("answers a member-only column with undefined rather than a plausible value", () => {
    // `ageTier` is the one a display path would otherwise compare against a
    // string and quietly get wrong.
    expect(bookingOwner(booking).member.ageTier).toBeUndefined();
  });

  it("says an unrecorded address is empty rather than inventing one", () => {
    const noAddress = { ...booking, organisation: { name: "Area School" } };
    expect(bookingOwner(noAddress).member.email).toBe("");
  });
});

describe("#3369: the view carries only what the caller selected", () => {
  it("omits `member` entirely when the caller did not load it", () => {
    const owner = bookingOwner({ memberId: "member-1" });
    expect("member" in owner).toBe(false);
    expect(owner.memberId).toBe("member-1");
  });

  it("omits `memberId` entirely when the caller did not load it", () => {
    const owner = bookingOwner({ member: MEMBER });
    expect("memberId" in owner).toBe(false);
  });

  it("keeps the caller's own nullability when the organisation was not loaded", () => {
    // Without the organisation there is nothing to project FROM, so the
    // accessor must not pretend otherwise — the caller says for itself what a
    // school booking means to it.
    const owner = bookingOwner({ memberId: null, member: null });
    expect(owner.member).toBeNull();
  });
});

describe("#3369: a booking owned by nobody fails closed", () => {
  it("throws when the owner is READ, rather than rendering a blank one", () => {
    // `Booking_owner_exactly_one` makes this unreachable. It throws anyway,
    // because a booking nobody owns cannot be invoiced, emailed or refunded and
    // a blank name would hide that from the person who could still fix it.
    const owner = bookingOwner({
      memberId: null,
      member: null,
      organisationId: null,
      organisation: null,
    });
    expect(() => owner.member).toThrow(BookingOwnerMissingError);
  });

  it("does NOT throw for a caller that only wanted the member id", () => {
    // The projection is lazy on purpose. An eager throw made a caller fail on
    // work it never asked for — it cost the diagnostics evidence pack its
    // honest "cannot evidence this" and gave it a crash instead.
    const owner = bookingOwner({
      memberId: null,
      member: null,
      organisationId: null,
      organisation: null,
    });
    expect(owner.memberId).toBeNull();
  });

  it("hands back nothing, not an exception, when the owner is NAMED but unreadable", () => {
    // A dangling reference is a different failure from an ownerless booking,
    // and it gets the answer it got before this stage: the relation was typed
    // non-null then too, and a broken row still arrived as `null`. Any caller
    // that survived that survives this.
    const owner = bookingOwner({
      memberId: "member-1",
      member: null as typeof MEMBER | null,
      organisationId: null,
      organisation: null,
    });
    expect(owner.member).toBeNull();
    expect(owner.memberId).toBe("member-1");
  });
});

describe("#3369: where a caller must actually SEND, or name a provider customer", () => {
  it("turns the honest blank address into an explicit null", () => {
    expect(
      bookingOwnerEmail({
        memberId: null,
        member: null,
        organisation: { name: "Area School" },
      }),
    ).toBeNull();
  });

  it("gives a real address back, trimmed", () => {
    expect(
      bookingOwnerEmail({
        memberId: null,
        member: null,
        organisation: { name: "S", email: "  office@tps.test " },
      }),
    ).toBe("office@tps.test");
    expect(bookingOwnerEmail({ memberId: MEMBER.id, member: MEMBER })).toBe(
      "ada@example.test",
    );
  });

  it("names a school's provider customer by ORGANISATION, never as a member", () => {
    // Writing an organisation id under the key `memberId` would carry the
    // school-as-person model into Stripe, where nothing can correct it later.
    expect(
      bookingOwnerProviderMetadata({
        memberId: null,
        member: null,
        organisationId: "org-1",
        organisation: SCHOOL,
      }),
    ).toEqual({ organisationId: "org-1" });
    expect(
      bookingOwnerProviderMetadata({
        memberId: "member-1",
        member: MEMBER,
        organisationId: null,
      }),
    ).toEqual({ memberId: "member-1" });
  });

  it("refuses to name a customer for a booking owned by nobody", () => {
    expect(() =>
      bookingOwnerProviderMetadata({ memberId: null, organisationId: null }),
    ).toThrow(BookingOwnerMissingError);
  });
});

describe("#3480: the owner's age tier has one home, and an organisation's is NOT_APPLICABLE", () => {
  // The rule was spelled inline at six sites as `member.ageTier ?? "NOT_APPLICABLE"`,
  // and a seventh had been written with `===`, which is false for the `undefined`
  // an organisation projects — a five-student school alone in the lodge stopped
  // drawing as a whole-lodge blockout (#3391). One spelling, asserted here.
  const memberOwned = {
    memberId: MEMBER.id,
    member: MEMBER,
    organisationId: null,
    organisation: null,
  };
  const schoolOwned = {
    memberId: null,
    member: null,
    organisationId: "org-1",
    organisation: SCHOOL,
  };

  it("hands a member's own tier back", () => {
    expect(bookingOwnerAgeTier(memberOwned)).toBe("ADULT");
    expect(bookingOwnerHasNoAgeTier(memberOwned)).toBe(false);
  });

  it("reads an organisation, which has no age, as NOT_APPLICABLE", () => {
    expect(bookingOwnerAgeTier(schoolOwned)).toBe("NOT_APPLICABLE");
    expect(bookingOwnerHasNoAgeTier(schoolOwned)).toBe(true);
  });

  it("gives the same answer for a school reached through a member-only selection", () => {
    // The projection cannot be built without the organisation, so the caller's
    // own `member: null` comes back — and a null member has no tier either.
    expect(bookingOwnerAgeTier({ memberId: null, member: null })).toBe("NOT_APPLICABLE");
  });

  it("treats an age-exempt account's own NOT_APPLICABLE the same way", () => {
    // The tier the invented school member carried, and the tier an age-exempt
    // account still carries: the predicate reads both as "no age tier".
    expect(
      bookingOwnerHasNoAgeTier({
        ...memberOwned,
        member: { ...MEMBER, ageTier: "NOT_APPLICABLE" as const },
      }),
    ).toBe(true);
  });
});
