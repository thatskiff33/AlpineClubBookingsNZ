/*
  CT-4 (#2870), epic #2988 — the day stamped into a config-transfer download.

  Both routes name their zip after "today", and both used to get that day from
  `todayDateOnlyForTimeZone()`, which reads `APP_TIME_ZONE` — the container's
  `TZ`. `INV-CONFIG-002` says the club's civil time is the persisted
  `ClubTimeSettings.timeZone` and nothing else, and the difference is visible to
  the person doing the transfer: on a club whose day has not yet rolled over,
  an environment-dated bundle is named for TOMORROW, and two bundles taken on
  the same club day can carry different dates.

  These are the only tests that drive either route handler — before this file
  nothing imported them at all, so the stamp had no coverage in either
  direction.

  WHY DENVER. The suite's frozen clock is 2026-07-01T00:00:00Z: midday on 1 July
  in New Zealand and still the evening of 30 JUNE in Denver. Persisting a zone
  the environment disagrees with is the whole of what makes a green run mean
  "the route read the club's setting" rather than "the two happened to agree".
*/
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireFullAdminForConfigTransfer: vi.fn(),
  readBundleUpload: vi.fn(),
  buildConfigExport: vi.fn(),
  resealBundle: vi.fn(),
  createAuditLog: vi.fn(),
  clubTimeSettingsFindUnique: vi.fn(),
}));

vi.mock("@/lib/config-transfer/route-helpers", () => ({
  requireFullAdminForConfigTransfer: mocks.requireFullAdminForConfigTransfer,
  readBundleUpload: mocks.readBundleUpload,
}));
vi.mock("@/lib/config-transfer/export", () => ({
  buildConfigExport: mocks.buildConfigExport,
}));
vi.mock("@/lib/config-transfer/bundle", () => ({
  resealBundle: mocks.resealBundle,
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    // The delegate the persisted-zone reader looks for. Omit it and
    // `loadPersistedClubTimeSettings()` returns null — fail-soft by design — and
    // both routes fall back to the container's `TZ` in silence.
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
  },
}));

import { POST as exportBundle } from "@/app/api/admin/config-transfer/export/route";
import { POST as resealBundleRoute } from "@/app/api/admin/config-transfer/reseal/route";
import { APP_TIME_ZONE } from "@/config/operational";
import { todayDateOnlyForTimeZone } from "@/lib/date-only";

const CLUB_ZONE_BEHIND_UTC = "America/Denver";
/** The club's day at the frozen clock, in `CLUB_ZONE_BEHIND_UTC`. */
const CLUB_TODAY = "2026-06-30";

function filenameOf(response: Response): string {
  return response.headers.get("Content-Disposition") ?? "";
}

/**
 * The premise, measured as an ANSWER rather than as a zone identifier. Two
 * different zone names can still name the same day — `America/Chicago` gives
 * Denver's answer here — so a name comparison would pass while the assertion
 * below went vacuous.
 *
 * `APP_TIME_ZONE` IS PASSED ON PURPOSE, and it is the one zone that belongs
 * here (#3123). This function's whole subject is the ENVIRONMENT authority — the
 * day the routes used to stamp, before CT-4 moved them onto the persisted
 * `ClubTimeSettings.timeZone`. Naming any other zone would make the disagreement
 * a coincidence between two literals rather than a measurement of the authority
 * the routes must NOT be obeying.
 */
function expectEnvironmentDisagrees() {
  expect(
    todayDateOnlyForTimeZone(APP_TIME_ZONE),
    "INV-CONFIG-002: the environment authority already names the club's day, so " +
      "this filename cannot tell which of the two the route read.",
  ).not.toBe(CLUB_TODAY);
}

describe("config-transfer downloads are stamped with the club's day (CT-4, #2870)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireFullAdminForConfigTransfer.mockResolvedValue({
      ok: true,
      memberId: "admin-1",
    });
    mocks.clubTimeSettingsFindUnique.mockResolvedValue({
      timeZone: CLUB_ZONE_BEHIND_UTC,
      updatedByMemberId: null,
      updatedAt: new Date(0),
    });
    mocks.buildConfigExport.mockResolvedValue({
      zip: new Uint8Array([1, 2, 3]),
      categories: ["club-settings"],
      entryCount: 1,
      imageCount: 0,
    });
    mocks.resealBundle.mockReturnValue(new Uint8Array([4, 5, 6]));
    mocks.readBundleUpload.mockResolvedValue({
      ok: true,
      upload: {
        bytes: new Uint8Array([7, 8, 9]),
        mode: "merge",
        resolutions: [],
        expectedFingerprint: null,
      },
    });
  });

  it("names an export bundle for the club's calendar day", async () => {
    expectEnvironmentDisagrees();

    const response = await exportBundle(
      new Request("http://localhost/api/admin/config-transfer/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ categories: ["club-settings"] }),
      }),
    );

    expect(response.status).toBe(200);
    // Under the environment's Pacific/Auckland this would be dated 2026-07-01 —
    // a day the club has not reached.
    expect(filenameOf(response)).toBe(
      `attachment; filename="config-transfer-${CLUB_TODAY}.zip"`,
    );
  });

  it("names a resealed bundle for the club's calendar day", async () => {
    expectEnvironmentDisagrees();

    const response = await resealBundleRoute(
      new Request("http://localhost/api/admin/config-transfer/reseal", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(filenameOf(response)).toBe(
      `attachment; filename="config-transfer-resealed-${CLUB_TODAY}.zip"`,
    );
  });
});
