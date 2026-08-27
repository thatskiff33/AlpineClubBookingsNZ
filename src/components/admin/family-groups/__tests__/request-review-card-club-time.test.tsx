// @vitest-environment jsdom

/**
 * Which authority dates the family-group request review card (CT-4, #2870;
 * `INV-CONFIG-002`, `INV-DATE-019`).
 *
 * ## Two values, two temporal kinds, one card
 *
 * This card renders exactly two dates and they are not the same kind of thing,
 * which is why one helper became two:
 *
 * - the request's `createdAt` is a real INSTANT and has no civil date until a
 *   zone is chosen. That zone is the club's PERSISTED one, which reaches the
 *   browser as data through `ClubTimeProvider` and arrives here as the
 *   `clubTime` prop.
 * - the requested/child `dateOfBirth` is a `@db.Date` CALENDAR DAY. It has no
 *   zone at all, and putting one on it names the day before for every club
 *   behind UTC — which is what decides an age tier, and an age tier decides a
 *   price band.
 *
 * ## Why this is a separate file from the other two card suites
 *
 * Those two render under the harness's default zone, which is deliberately the
 * one the environment also resolves to — so nothing they assert can tell the
 * persisted zone from the environment, whatever it renders. This file exists to
 * be the one that can. Each block below says what it would fail against.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { chooseDivergentClubZone } from "@/lib/__tests__/helpers/club-time-zone";
import { FamilyGroupRequestReviewCard } from "@/components/admin/family-groups/request-review-card";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import type { FamilyGroupRequest } from "@/lib/admin-family-group-ui-helpers";

afterEach(cleanup);

const noopHandlers = {
  onSelectMember: vi.fn(),
  onSearchTermChange: vi.fn(),
  onSearchMembers: vi.fn(),
  onNotificationParentChange: vi.fn(),
  onNoteChange: vi.fn(),
  onApprove: vi.fn(),
  onReject: vi.fn(),
  onClearRequestFeedback: vi.fn(),
};

/**
 * 04:00 UTC on 16 April 2026. Denver (−6) is still on 15 April at this instant
 * while UTC, Auckland and Kiritimati are all on the 16th, so the CIVIL DAY of
 * this one moment differs between zones — which is the whole point of it.
 */
const CREATED_AT = "2026-04-16T04:00:00.000Z";

/**
 * A date of birth as a `@db.Date` column serialises it: the calendar day encoded
 * at UTC midnight. Projecting THIS through any zone behind Greenwich lands on
 * the previous evening and names 31 December 2017.
 */
const CHILD_DOB_AS_STORED = "2018-01-01T00:00:00.000Z";

/** The medium house shape, asked of `Intl` directly so the oracle is independent. */
function mediumDateIn(zone: string, iso: string): string {
  return new Intl.DateTimeFormat("en-NZ", {
    timeZone: zone,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

function buildChildRequest(
  overrides: Partial<FamilyGroupRequest> = {},
): FamilyGroupRequest {
  return {
    id: "req-child",
    type: "CHILD_REQUEST",
    createdAt: CREATED_AT,
    requester: {
      id: "parent-1",
      firstName: "Ada",
      lastName: "Parent",
      email: "ada@example.com",
    },
    familyGroup: { id: "group-1", name: "Parent Family", members: [] },
    childFirstName: "Ivy",
    childLastName: "Parent",
    childDateOfBirth: CHILD_DOB_AS_STORED,
    childAgeLabel: "8 years",
    matchingMembers: [],
    ...overrides,
  };
}

function renderCard(
  zone: string,
  request: FamilyGroupRequest,
  requestSelection?: string,
) {
  return render(
    <FamilyGroupRequestReviewCard
      request={request}
      clubTime={bindClubTime(requireClubTimeZone(zone))}
      searchedMembers={[]}
      requestSelection={requestSelection}
      searching={false}
      submitting={false}
      canEdit
      showRemovalDetails
      {...noopHandlers}
    />,
  );
}

describe("the 'Requested' stamp reads the club's PERSISTED zone", () => {
  /*
    THE ZONE IS CHOSEN, NOT WRITTEN DOWN. `APP_TIME_ZONE` is an unvalidated
    `process.env.TZ` passthrough, so a contributor or a CI image running with
    `TZ=America/Denver` would turn a hard-coded "divergent" literal into the
    environment's own zone and quietly stop discriminating. The chooser picks the
    first candidate whose answer differs from the environment's, and checks each
    candidate's pinned literal against an independent oracle first, so a mistyped
    fixture fails loudly instead of weakening the assertion.

    Only the environment is a rival. Two calendar days exist at this instant, and
    the pair below covers both — see the "today" note in the chooser for why
    adding `"UTC"` to a two-day fixture can leave a correct tree with no
    candidate at all.
  */
  const chosen = chooseDivergentClubZone({
    subject: "the civil date of a family-group request's createdAt",
    answerKey: "stamp",
    cases: [
      // −6 at this date: still 15 April while the environment is on the 16th.
      { zone: "America/Denver", stamp: "15 Apr 2026" },
      // +14, no DST: already the 16th. The fallback for a Denver host.
      { zone: "Pacific/Kiritimati", stamp: "16 Apr 2026" },
    ],
    answerFor: (zone) => mediumDateIn(zone, CREATED_AT),
  });

  it("dates it in the bound zone, not in the environment's or the host's", () => {
    renderCard(chosen.zone, buildChildRequest());

    expect(screen.getByText(`Requested ${chosen.stamp}`)).toBeTruthy();
  });

  it("would show a different day if the binding were ignored", () => {
    // The negative that makes the positive above a proof of AUTHORITY rather
    // than of shape: a card that read `APP_TIME_ZONE`, or the host's zone,
    // renders one of these instead. Both are asserted absent because on a
    // default host they are the same string and on a Denver host they are not.
    renderCard(chosen.zone, buildChildRequest());

    const environmentStamp = mediumDateIn(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      CREATED_AT,
    );
    expect(chosen.stamp).not.toBe(environmentStamp);
    expect(screen.queryByText(`Requested ${environmentStamp}`)).toBeNull();
  });
});

describe("a date of birth is a calendar day and takes NO zone", () => {
  /*
    A FIXED, DELIBERATELY BEHIND-UTC ZONE HERE, and not a chosen one. This block
    does not assert that the club's zone was used — it asserts that it was NOT,
    which is the opposite question, so divergence from the environment is
    irrelevant and a zone behind Greenwich is the only thing that matters. Under
    Denver the UTC-midnight encoding of 1 January 2018 reads as 31 December 2017,
    so a card that passed this value through `clubTime` fails here on every host.
  */
  const BEHIND_UTC_ZONE = "America/Denver";

  it("renders the stored day, whatever the club's zone is", () => {
    // The premise, stated rather than assumed: this zone really does read that
    // instant as the previous day. If ICU ever disagreed, the negative below
    // would go vacuous without this line.
    expect(mediumDateIn(BEHIND_UTC_ZONE, CHILD_DOB_AS_STORED)).toBe(
      "31 Dec 2017",
    );

    const { container } = renderCard(BEHIND_UTC_ZONE, buildChildRequest());

    expect(container.textContent).toContain("Date of birth: 1 Jan 2018");
    expect(container.textContent).not.toContain("31 Dec 2017");
  });

  it("renders the same stored day from the bare yyyy-MM-dd spelling", () => {
    // The other shape a `@db.Date` column reaches a browser in, from a route
    // that encoded the day itself. Both must name one civil day.
    const { container } = renderCard(
      BEHIND_UTC_ZONE,
      buildChildRequest({ childDateOfBirth: "2018-01-01" }),
    );

    expect(container.textContent).toContain("Date of birth: 1 Jan 2018");
    expect(container.textContent).not.toContain("31 Dec 2017");
  });

  /*
    THE CARD RENDERS THIS DAY FROM THREE SEPARATE BRANCHES, and the two below are
    only reachable once the reviewer has chosen "create a new record" — the
    decision where a wrong date of birth is written into a member row rather than
    merely displayed. They are asserted because each is its own call site: a
    later edit can move one without the other, which is exactly how #2256 came
    to be spread across six surfaces.
  */
  it("keeps an ADULT request's DOB on the stored day in the create panel", () => {
    const { container } = renderCard(
      BEHIND_UTC_ZONE,
      buildChildRequest({
        id: "req-adult",
        type: "ADULT_REQUEST",
        childDateOfBirth: null,
        childFirstName: null,
        childLastName: null,
        requestedFirstName: "Bo",
        requestedLastName: "Parent",
        requestedEmail: "bo@example.com",
        requestedDateOfBirth: CHILD_DOB_AS_STORED,
        requestedAgeLabel: "40 years",
        canCreateMemberFromRequest: true,
      }),
      "__create__",
    );

    expect(container.textContent).toContain("New non-login adult will be created");
    expect(container.textContent).toContain("DOB 1 Jan 2018");
    expect(container.textContent).not.toContain("31 Dec 2017");
  });

  it("keeps a CHILD request's DOB on the stored day in the create panel", () => {
    const { container } = renderCard(
      BEHIND_UTC_ZONE,
      buildChildRequest({ canCreateMemberFromRequest: true }),
      "__create__",
    );

    expect(container.textContent).toContain(
      "New non-login dependant will be created",
    );
    expect(container.textContent).toContain("DOB 1 Jan 2018");
    expect(container.textContent).not.toContain("31 Dec 2017");
  });
});
