/**
 * A NOMINATION PAGE SPELLS ONE MOMENT IN THE CLUB'S ZONE AND ONE CALENDAR DAY IN
 * NO ZONE AT ALL (CT-4 group E, #2870; epic #2988; INV-CONFIG-002, INV-DATE-010).
 *
 * ## Why this page gets a suite when its five siblings get a sentence
 *
 * Five other pages in this group were migrated the same afternoon —
 * `notices/page.tsx`, `notices/[id]/page.tsx`, `profile/page.tsx`,
 * `(public)/membership-cancellation/[token]/page.tsx` and the stamps on
 * `bookings/[id]/page.tsx` — and every one of them is the identical one-line
 * change: `formatNZDate(new Date(x))` became `club.instantDate(new Date(x))`,
 * with `club` from `clubTime()`. That MECHANISM already has a behavioural pair,
 * in `src/app/__tests__/member-public-club-time-authority.test.tsx`, and a
 * sixth near-identical server-component harness would buy redundancy rather
 * than coverage.
 *
 * This page is the exception because its migration changed the KIND of a value
 * rather than the source of a zone. A dependent's date of birth used to be
 * pushed through `formatNZDate(new Date(`${dob}T00:00:00Z`))` — an encoding
 * projected through the container's zone, which is the identity only because New
 * Zealand is east of Greenwich. It is now a `CalendarDate`, formatted with no
 * zone at all. Nothing else in this group made that reclassification on a
 * date-of-birth, and a birthday printed a day early on a membership application
 * is exactly the kind of wrong that nobody reports and everybody notices.
 *
 * ## Both claims are made on one render, and they are opposite claims
 *
 * The page shows a submission STAMP (a real instant, which must follow the
 * club) one block above a dependent's DATE OF BIRTH (a calendar day, which must
 * not move for anybody). Driving the same fixture under two clubs is what
 * separates them: the stamp is required to change and the birthday is required
 * not to.
 *
 * ## The zones, and why each is the one it is
 *
 * - PERSISTED `America/Denver`, behind UTC, where the defects live. At the
 *   fixture instant it is still the previous day there.
 * - PERSISTED `Pacific/Auckland` for the other half of the pair. It is also what
 *   `APP_TIME_ZONE` falls back to wherever `TZ` is unset, CI included, so a page
 *   that had gone on reading the environment gives this column for both clubs.
 * - HOST `America/New_York`, pinned from `vi.hoisted` above the imports. Behind
 *   Greenwich on purpose: a calendar-date formatter that dropped its
 *   `timeZone: "UTC"` pin renders in the runtime's own zone, and on CI — `TZ`
 *   unset, host `UTC` — that is indistinguishable from a correct one.
 */

/*
  The host, moved before the first import. `restoreHostTimeZone` below is the
  shared #2485 rule; the reading is taken by hand because `vi.hoisted` runs
  above this file's imports and that binding does not exist yet.
*/
const { originalHostTimeZone } = vi.hoisted(() => {
  const original = {
    envTz: process.env.TZ,
    resolvedZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  process.env.TZ = "America/New_York";
  return { originalHostTimeZone: original };
});

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { restoreHostTimeZone } from "@/lib/__tests__/helpers/timezone";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getClubTimeZone: vi.fn(),
  nominationFindUnique: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

/*
  THE SEAM UNDER TEST. `clubTime()` resolves the club's identifier through this
  reader; a PARTIAL mock so the module's other exports stay real.
*/
vi.mock("@/lib/club-time-zone-settings", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getClubTimeZone: mocks.getClubTimeZone,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { nominationToken: { findUnique: mocks.nominationFindUnique } },
}));

vi.mock("@/lib/action-tokens", () => ({
  hashActionToken: (token: string) => `hashed:${token}`,
}));

vi.mock("@/components/nomination-confirm-card", () => ({
  NominationConfirmCard: () => null,
}));

import NominationPage from "../page";

/** 02:30 UTC on 16 April: 15 April in Denver, 16 April in Auckland. */
const SUBMITTED_AT = new Date("2026-04-16T02:30:00.000Z");

/** A dependent's birthday, stored the way `isoDateSchema` accepts it. */
const DATE_OF_BIRTH = "2014-04-16";

/** What both wrong authorities would make of that encoding: the day before. */
const BIRTHDAY_A_DAY_EARLY = "DOB 15 Apr 2014";

const AUCKLAND = "Pacific/Auckland";
const DENVER = "America/Denver";

afterAll(() => {
  // Never `delete process.env.TZ`: Node re-derives the zone on ASSIGNMENT only,
  // so a bare delete leaks this zone into whichever suite runs next (#2485).
  restoreHostTimeZone(originalHostTimeZone);
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "member-1" } });
  mocks.nominationFindUnique.mockResolvedValue({
    id: "nom-1",
    nominatorMemberId: "member-1",
    confirmedAt: null,
    expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    application: {
      id: "app-1",
      status: "PENDING_NOMINATORS",
      applicantFirstName: "Ana",
      applicantLastName: "Applicant",
      applicantEmail: "ana@example.test",
      createdAt: SUBMITTED_AT,
      familyMembers: [
        { firstName: "Kiri", lastName: "Applicant", dateOfBirth: DATE_OF_BIRTH },
      ],
    },
  });
});

async function renderFor(zone: string): Promise<string> {
  mocks.getClubTimeZone.mockResolvedValue(zone);
  return renderToStaticMarkup(
    await NominationPage({ params: Promise.resolve({ token: "tok-1" }) }),
  );
}

describe("the nomination page's two kinds of date (CT-4, #2870)", () => {
  it("the two clubs really read this moment as different days", () => {
    /*
      PREMISE AS AN ANSWER, from `Intl` rather than from the kernel: recomputing
      an expectation with the code under test proves only that the function is
      deterministic. If a runtime or a fixture edit ever put the two clubs on the
      same day, this fails here rather than leaving the pair below asserting the
      same thing twice.
    */
    const reading = (zone: string) =>
      new Intl.DateTimeFormat("en-NZ", {
        timeZone: zone,
        dateStyle: "medium",
      }).format(SUBMITTED_AT);
    expect(reading(DENVER)).toBe("15 Apr 2026");
    expect(reading(AUCKLAND)).toBe("16 Apr 2026");
    expect(reading(DENVER)).not.toBe(reading(AUCKLAND));

    // And the host is a third place, behind Greenwich, so a formatter with no
    // zone pin at all reads the birthday's UTC-midnight encoding a day early.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
      "America/New_York",
    );
  });

  it("stamps the submission with a behind-UTC club's day, and leaves the birthday", async () => {
    const html = await renderFor(DENVER);

    // The INSTANT follows the club.
    expect(html).toContain("15 Apr 2026");
    // The BIRTHDAY does not, even under the same club — and it is not what that
    // club's zone, or the host's, would make of the stored encoding: both read
    // it as the 15th. A different YEAR from the stamp on purpose, so neither
    // assertion can be satisfied by the other value on the page.
    expect(html).toContain("DOB 16 Apr 2014");
    expect(html).not.toContain(BIRTHDAY_A_DAY_EARLY);
    expect(mocks.getClubTimeZone).toHaveBeenCalled();
  });

  it("stamps the SAME submission with a different club's day, and still leaves the birthday", async () => {
    /*
      The other half, and what makes the case above about the PERSISTED SETTING
      rather than about a hard-coded 15 April. A page that resolved the
      environment, or its own host, has one answer to give and fails one half.
    */
    const html = await renderFor(AUCKLAND);

    expect(html).toContain("16 Apr 2026");
    expect(html).not.toContain("15 Apr 2026");
    expect(html).toContain("DOB 16 Apr 2014");
  });

  it("still renders when a stored dependent birthday names no real day", async () => {
    /*
      THE CRASH THE FIRST VERSION OF THIS MIGRATION SHIPPED (#2870 fix round).

      `requireCalendarDate` was justified in the diff by "the value has already
      passed `isoDateSchema`". It had — and that schema is
      `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)`, a SHAPE check. The
      UNAUTHENTICATED `/api/applications` POST validates the same field with the
      same bare regex, so `1990-02-31` is accepted on the way in and stored.
      `requireCalendarDate` then threw out of this async server component; there
      is no `error.tsx` under `(authenticated)`, so the nominating member lost
      the ability to confirm OR decline.

      MUTATION-VERIFIED: swap `parseCalendarDate` back for `requireCalendarDate`
      in `formatDependentDateOfBirth` and this case goes red with
      `Not a club calendar date: "1990-02-31". Expected YYYY-MM-DD naming a real
      day.`

      The assertions are about the PAGE, not the date: the two buttons the member
      needs are the thing the throw took away. 31 February is echoed rather than
      rolled to 3 March, which is what the pre-CT-4 spelling silently did.
    */
    mocks.nominationFindUnique.mockResolvedValue({
      id: "nom-1",
      nominatorMemberId: "member-1",
      confirmedAt: null,
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      application: {
        id: "app-1",
        status: "PENDING_NOMINATORS",
        applicantFirstName: "Ana",
        applicantLastName: "Applicant",
        applicantEmail: "ana@example.test",
        createdAt: SUBMITTED_AT,
        familyMembers: [
          { firstName: "Kiri", lastName: "Applicant", dateOfBirth: "1990-02-31" },
        ],
      },
    });

    const html = await renderFor(DENVER);

    expect(html).toContain("Kiri Applicant");
    expect(html).toContain("DOB 1990-02-31");
    // Not rolled forward into a plausible day that was never anybody's birthday.
    expect(html).not.toContain("3 Mar 1990");
    // And the stamp above it still rendered, so the page is whole rather than
    // half-built: the member can still act on the nomination.
    expect(html).toContain("15 Apr 2026");
  });
});
