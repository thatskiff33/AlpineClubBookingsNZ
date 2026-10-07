import { describe, expect, it } from "vitest";

import { generateSchoolGuests } from "@/lib/school-booking-constants";

/**
 * The school composition rule (#3486). The server stores this list and the
 * admin panel quotes from it, so the order and numbering are what an officer's
 * rate boxes and a member link's guest index both depend on.
 */
describe("generateSchoolGuests", () => {
  it("numbers children with one counter across every tier, in tier order", () => {
    const guests = generateSchoolGuests({
      teachers: [
        { firstName: "Tana", lastName: "Teacher" },
        { firstName: "Hemi", lastName: "Helper" },
      ],
      // Keys deliberately out of tier order: the tier list decides, not the object.
      childCounts: { YOUTH: 1, INFANT: 1, CHILD: 2 },
    });

    expect(guests).toEqual([
      { firstName: "Tana", lastName: "Teacher", ageTier: "ADULT" },
      { firstName: "Hemi", lastName: "Helper", ageTier: "ADULT" },
      { firstName: "School Child", lastName: "1", ageTier: "INFANT" },
      { firstName: "School Child", lastName: "2", ageTier: "CHILD" },
      { firstName: "School Child", lastName: "3", ageTier: "CHILD" },
      { firstName: "School Child", lastName: "4", ageTier: "YOUTH" },
    ]);
  });

  it("treats a missing or zero tier as no children, without skipping a number", () => {
    expect(
      generateSchoolGuests({ teachers: [], childCounts: { INFANT: 0, YOUTH: 2 } }),
    ).toEqual([
      { firstName: "School Child", lastName: "1", ageTier: "YOUTH" },
      { firstName: "School Child", lastName: "2", ageTier: "YOUTH" },
    ]);
  });
});
