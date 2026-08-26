// @vitest-environment jsdom

/**
 * WHOSE calendar year seeds a BULK membership assignment (CT-4, #2870).
 *
 * ## Why this needs its own file, and its own instant
 *
 * `MemberBulkMembershipDialog` seeds the season selector from
 * `calendarDateParts(clubTime.today()).year` and keeps that value whenever the
 * membership-types response omits `currentSeasonYear` — which the loader
 * explicitly tolerates. A season a year out here is applied to up to a hundred
 * members in one click, so it is the most consequential "the club's day, not the
 * viewer's" read in the members tree.
 *
 * The suite's default frozen instant (2026-07-01T00:00:00Z) CANNOT show it: mid
 * year, every zone on earth agrees about the year, so an assertion under any
 * zone passes whether the provider was consulted or not — and
 * `chooseDivergentClubZone` would correctly refuse to pick a candidate. The one
 * boundary where a year differs is New Year, which is exactly the case the
 * component's own comment names ("an admin in London on 1 January must seed the
 * same fallback as one at the lodge"). This file therefore pins its own instant,
 * per the `docs/TESTING.md` rule that a suite needing a different fixed instant
 * declares one in its own hook. It is pinned in `beforeEach` and the clock is
 * never handed back, so the root re-freeze cannot restore the default underneath
 * a later test in this file.
 *
 * The other bulk-dialog behaviours stay in `member-bulk-membership-dialog.test.tsx`
 * at the default instant; splitting is the house answer to a file that would
 * otherwise mix two clocks.
 */

import "@testing-library/jest-dom/vitest"
import type { ReactNode } from "react"
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ClubTimeProvider } from "@/components/club-time-provider"
import { APP_TIME_ZONE } from "@/config/operational"
import { chooseDivergentClubZone } from "@/lib/__tests__/helpers/club-time-zone"
import { MemberBulkMembershipDialog } from "../member-bulk-membership-dialog"

/**
 * New Year's Eve, midday UTC. New Zealand has already rolled over (NZDT is
 * UTC+13 in December); North America has not.
 */
const NEW_YEAR_EVE_UTC = new Date("2026-12-31T12:00:00.000Z")

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (value: string) => void
    children: ReactNode
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}))

/**
 * An INDEPENDENT oracle rather than the kernel under test, so one defect inside
 * `@/lib/club-time` cannot satisfy both sides of the comparison.
 */
const yearIn = (zone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric" }).format(
    new Date(),
  )

/**
 * Deliberately WITHOUT `currentSeasonYear`. The field is optional and the
 * loader keeps the club-derived fallback when it is absent, which is the branch
 * this file is about; a response that supplies it would overwrite the very value
 * under test.
 */
const TYPES_WITHOUT_SEASON = {
  membershipTypes: [{ id: "type-a", name: "Full", isActive: true }],
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("MemberBulkMembershipDialog seeds the season from the CLUB's year (CT-4, #2870)", () => {
  beforeEach(() => {
    vi.setSystemTime(NEW_YEAR_EVE_UTC)
  })

  it("uses the persisted club zone's year, not APP_TIME_ZONE's, across the New Year boundary", async () => {
    const chosen = chooseDivergentClubZone({
      subject: "the club's calendar year on New Year's Eve",
      answerKey: "year",
      cases: [
        { zone: "America/Denver", year: 2026 }, // −7: still 31 December 2026
        { zone: "Pacific/Kiritimati", year: 2027 }, // +14: already 1 January 2027
      ],
      answerFor: yearIn,
      // NOT `["UTC"]`. This is a "what day is it" question with only two or
      // three answers in existence at one instant, so a third rival can leave a
      // correct tree with no candidate at all.
    })
    // No hand-written "and it differs from the environment" line: `answerKey`
    // makes the chooser check every candidate's literal against its own zone's
    // answer, so `chosen.year` is provably the chosen zone's and provably not
    // the environment's. `environmentYear` is still needed for the negative
    // assertion at the end.
    const environmentYear = Number(yearIn(APP_TIME_ZONE))

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => TYPES_WITHOUT_SEASON }) as Response),
    )

    render(
      <MemberBulkMembershipDialog
        open
        selectedIds={new Set(["m1", "m2"])}
        memberNames={new Map([["m1", "Alice"], ["m2", "Bob"]])}
        onOpenChange={vi.fn()}
        onComplete={vi.fn()}
        onError={vi.fn()}
      />,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <ClubTimeProvider zone={chosen.zone}>{children}</ClubTimeProvider>
        ),
      },
    )

    // The selector marks the seeded year as the current season, and it is the
    // value the bulk POST would carry for every selected member.
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: `${chosen.year} (current season)` }),
      ).toBeTruthy(),
    )
    expect(
      screen.queryByRole("option", { name: `${environmentYear} (current season)` }),
    ).toBeNull()
  })
})
