import { describe, it, expect } from "vitest";

// Parent/dependent management tests removed — parent/dependent model replaced by family groups.
// See: https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/35

describe("Joined Date Display Logic", () => {
  it("uses joinedDate when available", () => {
    const joinedDate = "2020-05-15T00:00:00.000Z";
    const createdAt = "2026-04-01T00:00:00.000Z";
    const displayDate = new Date(joinedDate || createdAt).toLocaleDateString(
      "en-NZ", { day: "numeric", month: "short", year: "numeric" }
    );
    expect(displayDate).toContain("2020");
  });

  it("falls back to createdAt when joinedDate is null", () => {
    const joinedDate = null;
    const createdAt = "2026-04-01T00:00:00.000Z";
    const displayDate = new Date(joinedDate || createdAt).toLocaleDateString(
      "en-NZ", { day: "numeric", month: "short", year: "numeric" }
    );
    expect(displayDate).toContain("2026");
  });
});
