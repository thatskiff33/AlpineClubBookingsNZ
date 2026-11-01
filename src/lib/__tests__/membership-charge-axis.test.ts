/**
 * THE ACCESSOR'S OWN BEHAVIOUR (INV-SSOT-007, INV-MONEY-045).
 *
 * The census beside this file proves every family-dedup-key/display-name
 * read goes THROUGH `chargeFamilyAxisKey`/`chargeAxisDisplayName`. This one
 * proves what they return when called — most importantly, that a `null`
 * membershipTypeId never gets silently interpolated into the key the way a
 * raw template literal would.
 */
import { describe, expect, it } from "vitest";

import {
  chargeAxisDisplayName,
  chargeFamilyAxisKey,
} from "@/lib/membership-charge-axis";

describe("chargeFamilyAxisKey", () => {
  it("keys a type-axis charge on its membershipTypeId", () => {
    const key = chargeFamilyAxisKey({
      seasonYear: 2027,
      familyGroupId: "family-1",
      membershipTypeId: "type-senior",
      subscriptionCategoryId: null,
    });
    expect(key).toBe("2027:type:type-senior:family:family-1");
  });

  it("keys a category-axis charge on its subscriptionCategoryId, never on the null membershipTypeId", () => {
    const key = chargeFamilyAxisKey({
      seasonYear: 2027,
      familyGroupId: "family-1",
      membershipTypeId: null,
      subscriptionCategoryId: "category-couple",
    });
    expect(key).toBe("2027:category:category-couple:family:family-1");
    // The literal string "null" must never appear where an id is expected —
    // this is exactly the silent-collision hazard a raw
    // `${charge.membershipTypeId}` template literal produces.
    expect(key).not.toContain(":type:null:");
  });

  it("gives a type charge and a category charge for the SAME family DIFFERENT keys", () => {
    const typeKey = chargeFamilyAxisKey({
      seasonYear: 2027,
      familyGroupId: "family-1",
      membershipTypeId: "type-senior",
      subscriptionCategoryId: null,
    });
    const categoryKey = chargeFamilyAxisKey({
      seasonYear: 2027,
      familyGroupId: "family-1",
      membershipTypeId: null,
      subscriptionCategoryId: "category-couple",
    });
    expect(typeKey).not.toBe(categoryKey);
  });

  it("gives two charges on the SAME axis, same family, same season the SAME key", () => {
    const first = chargeFamilyAxisKey({
      seasonYear: 2027,
      familyGroupId: "family-1",
      membershipTypeId: "type-senior",
      subscriptionCategoryId: null,
    });
    const second = chargeFamilyAxisKey({
      seasonYear: 2027,
      familyGroupId: "family-1",
      membershipTypeId: "type-senior",
      subscriptionCategoryId: null,
    });
    expect(first).toBe(second);
  });
});

describe("chargeAxisDisplayName", () => {
  it("returns the type name when the charge billed on the type axis", () => {
    expect(
      chargeAxisDisplayName({
        membershipTypeName: "Senior",
        subscriptionCategoryName: null,
      }),
    ).toBe("Senior");
  });

  it("returns the category name when the charge billed on the category axis", () => {
    expect(
      chargeAxisDisplayName({
        membershipTypeName: null,
        subscriptionCategoryName: "Couple",
      }),
    ).toBe("Couple");
  });

  it("falls back to a generic label rather than rendering blank or 'null'", () => {
    expect(
      chargeAxisDisplayName({
        membershipTypeName: null,
        subscriptionCategoryName: null,
      }),
    ).toBe("Subscription");
  });
});
