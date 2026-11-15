import { describe, expect, it } from "vitest";
import { classifyModificationRequest } from "@/lib/booking-edit-price-class";

/**
 * ALP-573: `classifyModificationRequest` is the one answer the preview
 * (`modify-quote`) and the save (`modifyBookingBatch`) both take on whether an
 * edit moves money. These cases pin the request shapes whose classification
 * the shared function changed or must keep, so a later edit to the field list
 * cannot silently move one of them.
 */
const rename = [{ guestId: "g1", firstName: "Ana", lastName: "Smith" }];

describe("classifyModificationRequest", () => {
  it("treats a rename that resends the stored names as identity-only and price-preserving", () => {
    // The classification reads the REQUEST, not which names differ, so a no-op
    // rename takes the stored-price echo on both sides.
    expect(classifyModificationRequest({ guestUpdates: rename })).toEqual({
      identityOnly: true,
      creditElectionOnly: false,
      pricePreserving: true,
    });
  });

  it("treats a credit election alone as credit-only and price-preserving", () => {
    expect(classifyModificationRequest({ applyCreditCents: 5000 })).toEqual({
      identityOnly: false,
      creditElectionOnly: true,
      pricePreserving: true,
    });
  });

  it("treats a credit election of zero cents as a credit election", () => {
    expect(classifyModificationRequest({ applyCreditCents: 0 }).creditElectionOnly).toBe(true);
  });

  it("treats a rename with a credit election as identity-only, not credit-only, and price-preserving", () => {
    expect(
      classifyModificationRequest({ guestUpdates: rename, applyCreditCents: 5000 }),
    ).toEqual({
      identityOnly: true,
      creditElectionOnly: false,
      pricePreserving: true,
    });
  });

  it("keeps a rename with an other-lodge election identity-only but never price-preserving (#2978)", () => {
    // The other-lodge fields are not structural for identityOnly, so the
    // quote-priced and paid-typo gates treat the rename as a rename on both
    // sides; the election itself must still reach the rate resolver.
    expect(
      classifyModificationRequest({
        guestUpdates: rename,
        otherLodgeMemberGuestIds: ["g1"],
      }),
    ).toEqual({
      identityOnly: true,
      creditElectionOnly: false,
      pricePreserving: false,
    });
    expect(
      classifyModificationRequest({ guestUpdates: rename, otherLodgeId: "lodge-1" }),
    ).toEqual({
      identityOnly: true,
      creditElectionOnly: false,
      pricePreserving: false,
    });
    // `null` clears the election, which is still an election.
    expect(
      classifyModificationRequest({ applyCreditCents: 100, otherLodgeId: null })
        .pricePreserving,
    ).toBe(false);
  });

  it.each([
    ["a new check-in date", { checkIn: "2027-07-01" }],
    ["a new check-out date", { checkOut: "2027-07-05" }],
    ["an added guest", { addGuests: [{}] }],
    ["a removed guest", { removeGuestIds: ["g2"] }],
    ["a per-guest stay range", { guestStayRanges: [{}] }],
    ["a member link (#2337)", { linkGuestToMember: [{}] }],
    ["a promo code", { promoCode: "SKI10" }],
    ["a promo removal", { removePromoCode: true }],
  ])("treats a rename or credit election with %s as structural", (_label, extra) => {
    for (const base of [{ guestUpdates: rename }, { applyCreditCents: 5000 }]) {
      expect(classifyModificationRequest({ ...base, ...extra })).toEqual({
        identityOnly: false,
        creditElectionOnly: false,
        pricePreserving: false,
      });
    }
  });

  it("treats an empty request as neither identity-only nor credit-only", () => {
    expect(classifyModificationRequest({})).toEqual({
      identityOnly: false,
      creditElectionOnly: false,
      pricePreserving: false,
    });
    // An empty guest-update list is not a rename.
    expect(classifyModificationRequest({ guestUpdates: [] }).identityOnly).toBe(false);
  });
});
