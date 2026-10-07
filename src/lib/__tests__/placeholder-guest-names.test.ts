import { describe, expect, it } from "vitest";

import {
  countPlaceholderGuestNames,
  hasPlaceholderGuestNames,
  isPlaceholderGuestName,
  MEMBER_WHOLE_LODGE_GUEST_NAME_PREFIX,
  PLACEHOLDER_GUEST_NAME_PREFIXES,
  SCHOOL_CHILD_NAME_PREFIX,
} from "@/lib/placeholder-guest-names";
import { buildMemberWholeLodgePlaceholderGuests } from "@/lib/booking-request";
import { generateSchoolGuests } from "@/lib/school-booking-constants";

/**
 * #2550 — the detector that decides whether a guest is still carrying the name
 * a generator gave it. The acceptance criteria name two directions explicitly:
 * a renamed placeholder must read as NAMED, and a real person legitimately
 * called Guest must not be dragged in.
 */
describe("placeholder guest name detector (#2550)", () => {
  it("matches the exact shape the whole-lodge generator produces", () => {
    const generated = buildMemberWholeLodgePlaceholderGuests(3);

    expect(generated).toHaveLength(3);
    for (const guest of generated) {
      expect(isPlaceholderGuestName(guest)).toBe(true);
    }
    expect(countPlaceholderGuestNames(generated)).toBe(3);
  });

  it("matches the exact shape the school generator produces, and leaves named teachers alone", () => {
    const generated = generateSchoolGuests({
      teachers: [{ firstName: "Terry", lastName: "Teacher" }],
      childCounts: { CHILD: 2, YOUTH: 1 },
    });

    expect(generated).toHaveLength(4);
    expect(countPlaceholderGuestNames(generated)).toBe(3);
    expect(
      isPlaceholderGuestName({ firstName: "Terry", lastName: "Teacher" }),
    ).toBe(false);
  });

  it("treats a renamed placeholder as named", () => {
    expect(
      isPlaceholderGuestName({ firstName: "Guest", lastName: "1" }),
    ).toBe(true);
    // The rename keeps the same guest row; only the two name columns change.
    expect(
      isPlaceholderGuestName({ firstName: "Jane", lastName: "Smith" }),
    ).toBe(false);
  });

  it("does not false-positive on a real person whose name really is Guest", () => {
    expect(
      isPlaceholderGuestName({ firstName: "Guest", lastName: "Fisher" }),
    ).toBe(false);
    expect(
      isPlaceholderGuestName({ firstName: "Guesty", lastName: "3" }),
    ).toBe(false);
    // The ordinal is written with String(index + 1): no signs, decimals,
    // separators, leading zeroes, or empty last names.
    for (const lastName of ["", " ", "0", "01", "-1", "1.0", "1a", "1 2"]) {
      expect(
        isPlaceholderGuestName({ firstName: "Guest", lastName }),
      ).toBe(false);
    }
  });

  it("never treats a member-linked guest as a placeholder", () => {
    expect(
      isPlaceholderGuestName({
        firstName: "Guest",
        lastName: "2",
        isMember: true,
      }),
    ).toBe(false);
    expect(
      isPlaceholderGuestName({
        firstName: "School Child",
        lastName: "2",
        memberId: "m-1",
      }),
    ).toBe(false);
  });

  it("tolerates surrounding whitespace in either column", () => {
    expect(
      isPlaceholderGuestName({ firstName: " Guest ", lastName: " 4 " }),
    ).toBe(true);
  });

  it("reports a partially named party as still unnamed", () => {
    const party = [
      { firstName: "Guest", lastName: "1" },
      { firstName: "Ana", lastName: "Rangi" },
      { firstName: "Guest", lastName: "3" },
    ];

    expect(hasPlaceholderGuestNames(party)).toBe(true);
    expect(countPlaceholderGuestNames(party)).toBe(2);
    expect(
      hasPlaceholderGuestNames([{ firstName: "Ana", lastName: "Rangi" }]),
    ).toBe(false);
    expect(countPlaceholderGuestNames([])).toBe(0);
  });

  it("keeps the shared prefixes in step with both generators", () => {
    expect(PLACEHOLDER_GUEST_NAME_PREFIXES).toEqual([
      MEMBER_WHOLE_LODGE_GUEST_NAME_PREFIX,
      SCHOOL_CHILD_NAME_PREFIX,
    ]);
    expect(buildMemberWholeLodgePlaceholderGuests(1)[0].firstName).toBe(
      MEMBER_WHOLE_LODGE_GUEST_NAME_PREFIX,
    );
    expect(
      generateSchoolGuests({ teachers: [], childCounts: { CHILD: 1 } })[0]
        .firstName,
    ).toBe(SCHOOL_CHILD_NAME_PREFIX);
  });
});
