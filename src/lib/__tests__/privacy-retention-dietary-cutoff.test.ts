import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
// The real kernel bound to a Pacific/Auckland club, so the cutoff is derived
// from the club's civil date rather than the UTC date or the host zone.
vi.mock("@/lib/club-time/server", async () => {
  const { bindClubTime, requireClubTimeZone } = await import("@/lib/club-time");
  const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
  const bound = bindClubTime(requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST);
  return { clubTime: async () => bound };
});

import { privacyRetentionSelection } from "@/lib/privacy-retention-selection";
import { DEFAULT_PRIVACY_RETENTION_SETTINGS } from "@/lib/privacy-retention-shared";

const cutoffAt = async (instant: string, bookingDietaryRetentionDays = 30) =>
  (await privacyRetentionSelection({ ...DEFAULT_PRIVACY_RETENTION_SETTINGS, bookingDietaryRetentionDays }, new Date(instant)))
    .bookingDietaryCutoff.toISOString();

describe("after-stay dietary cutoff (#4916)", () => {
  it("is the club's civil date minus the period, as a date-only instant", async () => {
    expect(await cutoffAt("2026-07-01T00:00:00.000Z")).toBe("2026-06-01T00:00:00.000Z");
    expect(await cutoffAt("2026-07-01T00:00:00.000Z", 1)).toBe("2026-06-30T00:00:00.000Z");
    expect(await cutoffAt("2026-07-01T00:00:00.000Z", 365)).toBe("2025-07-01T00:00:00.000Z");
  });

  it("does not move when the UTC date changes at midday NZ", async () => {
    // 11:59 and 12:00 NZST on 1 July straddle the UTC date change; the club's day is 1 July throughout.
    expect(await cutoffAt("2026-06-30T23:59:59.999Z")).toBe("2026-06-01T00:00:00.000Z");
    expect(await cutoffAt("2026-07-01T00:00:00.000Z")).toBe("2026-06-01T00:00:00.000Z");
  });

  it("moves at the club's midnight, not UTC midnight", async () => {
    expect(await cutoffAt("2026-06-30T11:59:59.999Z")).toBe("2026-05-31T00:00:00.000Z");
    expect(await cutoffAt("2026-06-30T12:00:00.000Z")).toBe("2026-06-01T00:00:00.000Z");
  });
});
