import { describe, expect, it, vi } from "vitest";

import { APP_TIME_ZONE } from "@/config/operational";
import {
  clubCalendarDateOf,
  clubToday,
  clubWallTimeOf,
  formatClubInstantTime,
  formatClubMonthYear,
  requireCalendarDate,
  requireInstant,
  startOfCalendarMonth,
  startOfClubDay,
} from "@/lib/club-time";
import { divergentClubZone } from "./helpers/club-time-zone";
import { withTimeZone } from "./helpers/timezone";

/**
 * Proof that the calendar subsystem's zone-authority suites STAY discriminating
 * on the machines this repository is actually run on (CT-4 group F5, #2870).
 *
 * ## Why this file exists, measured rather than reasoned
 *
 * `divergentClubZone` refuses to certify a fixture for which no club zone
 * diverges from both `APP_TIME_ZONE` and the host's own zone — correctly, because
 * such a fixture cannot tell a correct implementation from a wrong one. The
 * refusal is a loud FAILURE and never a skip (owner decision, #2870), which means
 * a fixture that only works on the author's machine turns the suite RED
 * somewhere else instead of quietly going blind.
 *
 * That is the right failure mode and a terrible thing to discover on CI. This
 * repository's own CI runner resolves the host zone as plain `UTC` while
 * `APP_TIME_ZONE` falls back to `Pacific/Auckland`; a New Zealand developer's
 * machine resolves both as `Pacific/Auckland`; a North American one resolves the
 * host behind UTC. Each of those is a different pair of "wrong answers", so each
 * leaves a different day free — and a fixture measured on one of them says
 * nothing about the others. During this lane a first pass at these fixtures was
 * green on a New Zealand machine and would have refused every candidate on CI.
 *
 * So the premise is checked here for every host shape, over the actual fixture
 * derivations the suites use. `withTimeZone` moves the process's own zone, which
 * is what the chooser probes; `APP_TIME_ZONE` is frozen at import and cannot be
 * moved, which is why the CI shape (host `UTC`, environment `Pacific/Auckland`)
 * is reachable from here at all.
 *
 * WHAT THIS DOES NOT PROVE: that the suites pass under a different
 * `APP_TIME_ZONE`. That value is read once at module load, so a behind-UTC
 * environment zone needs a re-imported module graph — CT-6's hostile-zone proof
 * (#2991) owns that, and this file states the limit rather than implying more.
 */

/** The host zones this repository is run on, plus both offset extremes. */
const HOST_SHAPES = [
  "UTC", // the CI runner — and NOT a valid club zone, which is the trap
  "Pacific/Auckland", // a New Zealand developer
  "America/Denver", // a North American developer
  "Europe/London",
  "Pacific/Kiritimati", // UTC+14
  "Pacific/Pago_Pago", // UTC-11
];

/**
 * Every fixture derivation the F5 zone-authority suites hand the chooser, named
 * so a failure says which suite would have gone red.
 *
 * `exceptHosts` records the one derivation that genuinely cannot discriminate on
 * every host, with the reason, rather than being quietly dropped from the list.
 */
const FIXTURES: Array<{
  name: string;
  derive: Parameters<typeof divergentClubZone>[0];
  exceptHosts?: readonly string[];
}> = [
    {
      name: "calendar-recurrence: anchor's club day",
      derive: (z) => clubCalendarDateOf(requireInstant("2026-07-21T10:30:00.000Z"), z),
    },
    {
      name: "calendar-recurrence: describeRecurrence anchor day",
      derive: (z) => {
        const date = clubCalendarDateOf(
          requireInstant("2026-07-21T10:30:00.000Z"),
          z,
        );
        return date.slice(8);
      },
    },
    {
      name: "calendar-client-grouping: event's club day",
      derive: (z) => clubCalendarDateOf(requireInstant("2026-08-15T10:30:00.000Z"), z),
    },
    {
      name: "calendar-service: anchor's club day",
      derive: (z) => clubCalendarDateOf(requireInstant("2026-07-21T10:30:00.000Z"), z),
    },
    {
      name: "calendar-client: date input value",
      derive: (z) =>
        clubCalendarDateOf(requireInstant("2026-04-16T10:30:00.000Z"), z) as string,
    },
    {
      name: "calendar-client: time input value",
      derive: (z) => {
        const wall = clubWallTimeOf(requireInstant("2026-04-16T10:30:00.000Z"), z);
        return `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
      },
    },
    {
      name: "calendar-client: chip time label",
      derive: (z) =>
        formatClubInstantTime(requireInstant("2026-04-16T10:30:00.000Z"), z),
    },
    {
      name: "calendar-client: grid window lower bound",
      derive: (z) => startOfClubDay(requireCalendarDate("2026-03-30"), z).toISOString(),
    },
    {
      name: "components: club today",
      derive: (z) => clubToday(z) as string,
    },
    {
      name: "components: month heading from the club's today",
      derive: (z) => formatClubMonthYear(startOfCalendarMonth(clubToday(z))),
      /*
        A MONTH heading is coarser than a day and this is where that bites. The
        three days that exist at the pinned instant are 30 June, 1 July and
        2 July, so they name only TWO months — three consecutive days never span
        three. A host at UTC-11 is on June while `APP_TIME_ZONE` is on July, which
        takes both, and no club zone is left that names a third month.

        The consequence is bounded and named rather than papered over: on a
        UTC-11 host that ONE assertion in
        `components/calendar/__tests__/calendar-club-time-authority.test.tsx`
        fails its premise loudly (never silently), and the club-month claim is
        also carried there by the grid-window assertion beside it, which derives
        from an INSTANT and so has many possible values on any host. Every host
        this repository is actually run on — the CI runner, and a New Zealand,
        European or North American developer — is covered.
      */
      exceptHosts: ["Pacific/Pago_Pago"],
    },
  ];

describe("the F5 zone-authority fixtures stay discriminating on every host shape", () => {
  it.each(HOST_SHAPES)(
    "finds a divergent club zone with the process pinned to %s",
    (host) => {
      // The two "today" fixtures need an instant inside the three-days-on-earth
      // window; the repository's frozen clock is at 00:00 UTC. The component
      // suite pins the same instant for the same reason.
      vi.setSystemTime(new Date("2026-07-01T10:30:00.000Z"));
      withTimeZone(host, () => {
        for (const fixture of FIXTURES) {
          if (fixture.exceptHosts?.includes(host)) continue;
          const chosen = divergentClubZone(fixture.derive);
          expect(
            JSON.stringify(chosen.expected),
            `${fixture.name} would not discriminate with the host on ${host}`,
          ).not.toBe(JSON.stringify(chosen.environmentAnswer));
          expect(
            JSON.stringify(chosen.expected),
            `${fixture.name} would not discriminate with the host on ${host}`,
          ).not.toBe(JSON.stringify(chosen.hostAnswer));
        }
      });
    },
  );

  it("keeps every exception declared with a host it is claimed for", () => {
    // A stale `exceptHosts` entry would silently stop a fixture being checked
    // anywhere, so each one has to name a host this file really pins.
    for (const fixture of FIXTURES) {
      for (const host of fixture.exceptHosts ?? []) {
        expect(
          HOST_SHAPES,
          `${fixture.name} excludes ${host}, which is not one of the host shapes this file pins`,
        ).toContain(host);
      }
    }
    // The environment axis is not this file's claim (CT-6, #2991) — recorded so
    // a failure elsewhere can be read against the value it was measured under.
    expect(typeof APP_TIME_ZONE).toBe("string");
    expect(APP_TIME_ZONE.length).toBeGreaterThan(0);
  });
});
