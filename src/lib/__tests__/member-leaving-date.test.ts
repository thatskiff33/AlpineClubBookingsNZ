import { describe, expect, it } from "vitest";
import { leavingDateForDeactivation } from "@/lib/member-leaving-date";

describe("leaving date for the current absence", () => {
  const today = new Date("2026-07-01");
  const prior = new Date("2018-02-28");

  it("records a new departure when an active member leaves again", () => {
    expect(leavingDateForDeactivation({ active: true, leavingDate: prior }, today)).toBe(today);
  });

  it("preserves a known departure when an inactive member is archived or cancelled", () => {
    expect(leavingDateForDeactivation({ active: false, leavingDate: prior }, today)).toBe(prior);
  });

  it("dates an explicit deactivation when no departure was recorded", () => {
    expect(leavingDateForDeactivation({ active: false, leavingDate: null }, today)).toBe(today);
  });
});
