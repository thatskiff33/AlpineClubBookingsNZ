import { describe, expect, it } from "vitest";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { APP_TIME_ZONE } from "@/config/operational";
import { formatReferenceCacheLabel } from "../_components/shared";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

/**
 * #2256 first fixed this label: it was built from bare `toLocaleString()` calls,
 * so the Xero account/item cache stamps rendered in the admin's own browser
 * locale and zone. CT-4 (#2870) finished the job — the zone is now the club's
 * PERSISTED `ClubTimeSettings.timeZone`, supplied by the caller's binding, and
 * not `APP_TIME_ZONE` (INV-CONFIG-002).
 *
 * ## Why the zone here is `America/Denver` and not `Pacific/Auckland`
 *
 * Because a test under `Pacific/Auckland` CANNOT TELL THE TWO APART. That is the
 * zone `APP_TIME_ZONE` resolves to under test and the zone the old code used, so
 * the migrated code and the code it replaced return the identical string —
 * "false and green", the trap `CLUB_TIME_KERNEL.md` names. `America/Denver` is
 * behind UTC, where the defects show: at the fixture instant it disagrees with
 * `APP_TIME_ZONE` on the DAY and with the host's UTC clock on the HOUR, so the
 * single expected string below is reachable from neither.
 */
describe("formatReferenceCacheLabel (#2256, CT-4 #2870)", () => {
  /** The club's persisted zone for this suite. Deliberately not the environment's. */
  const CLUB_ZONE = "America/Denver";
  const clubTime = bindClubTime(requireClubTimeZone(CLUB_ZONE));

  // 2026-04-15T23:30:00Z is 16 Apr 11:30 am in Pacific/Auckland, 15 Apr 5:30 pm
  // in America/Denver and 15 Apr 11:30 pm in UTC. Three different answers, which
  // is what makes the assertion below discriminating.
  const CACHE = {
    source: "database" as const,
    lastRefreshedAt: "2026-04-15T23:30:00.000Z",
    expiresAt: "2026-04-16T11:30:00.000Z",
  };

  it("has a premise: the environment zone gives a DIFFERENT answer from the club's", () => {
    // Not `expect(APP_TIME_ZONE).not.toBe("America/Denver")` — an identifier
    // check passes under America/Chicago while the assertion below goes vacuous.
    // What matters is that the two zones disagree on THIS instant.
    const environmentAnswer = bindClubTime(
      requireClubTimeZone(APP_TIME_ZONE),
    ).instantDateTime(new Date(CACHE.lastRefreshedAt));
    const clubAnswer = clubTime.instantDateTime(new Date(CACHE.lastRefreshedAt));
    expect(clubAnswer).not.toBe(environmentAnswer);
  });

  it("renders both stamps in the club's persisted zone, not the host's and not APP_TIME_ZONE", () => {
    // Pinned to UTC so the host is a third zone again: if the binding were
    // ignored in favour of the host, the hour below would be 11:30 pm.
    const label = withTimeZone("UTC", () =>
      formatReferenceCacheLabel(clubTime, "Accounts", CACHE),
    );
    expect(label).toBe(
      "Accounts: shared cache, refreshed 15 Apr 2026, 5:30 pm, expires 16 Apr 2026, 5:30 am",
    );
  });

  it("still degrades to 'unknown' on an unparseable stamp instead of throwing", () => {
    const label = formatReferenceCacheLabel(clubTime, "Accounts", {
      ...CACHE,
      expiresAt: "not-a-date",
    });
    expect(label).toContain("refreshed 15 Apr 2026, 5:30 pm");
    expect(label).toContain("expires unknown");
  });

  it("treats an offset-less ISO stamp as unknown rather than reading it in the host's zone", () => {
    // Tightened by CT-4: `new Date("2026-04-16T11:30:00")` used to parse that
    // string as a wall-clock reading in whichever zone happened to be running,
    // which is the whole defect class this epic closes.
    const label = formatReferenceCacheLabel(clubTime, "Accounts", {
      ...CACHE,
      expiresAt: "2026-04-16T11:30:00",
    });
    expect(label).toContain("expires unknown");
  });

  it("keeps the no-metadata message", () => {
    expect(formatReferenceCacheLabel(clubTime, "Items", null)).toBe(
      "Items: no cache metadata yet",
    );
  });
});
