import { afterEach, describe, expect, it } from "vitest";
import {
  buildInitialRequestNotificationParents,
  buildInitialRequestSelections,
  buildSharedEmailClusters,
  formatFamilyGroupCalendarDay,
  formatFamilyGroupInstantDate,
  getFamilyGroupRequestSummary,
  getFamilyGroupRequestTypeLabel,
  mapFamilyGroupRequestSearchResults,
  mergeFamilyGroupRequestCandidates,
  type FamilyGroupMemberRow,
  type FamilyGroupRequest,
} from "@/lib/admin-family-group-ui-helpers";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";

const baseRequest: FamilyGroupRequest = {
  id: "request-1",
  type: "CHILD_REQUEST",
  createdAt: "2026-05-01T00:00:00.000Z",
  requester: {
    id: "parent-1",
    firstName: "Ada",
    lastName: "Parent",
    email: "ada@example.com",
  },
  familyGroup: {
    id: "group-1",
    name: "Parent Family",
    members: [
      {
        id: "parent-1",
        firstName: "Ada",
        lastName: "Parent",
        email: "ada@example.com",
        ageTier: "ADULT",
      },
    ],
  },
  childFirstName: "Bea",
  childLastName: "Child",
  childDateOfBirth: "2018-01-01",
  matchingMembers: [
    {
      id: "child-1",
      firstName: "Bea",
      lastName: "Child",
      email: "ada@example.com",
      ageTier: "CHILD",
      active: true,
      canLogin: false,
      // #2568: matches carry the server-calculated age, never a birth date.
      ageLabel: "8 years",
      alreadyInGroup: false,
      parentLinks: [],
    },
  ],
};

describe("admin-family-group-ui-helpers", () => {
  it("defaults child request selections and notification parents", () => {
    expect(buildInitialRequestSelections([baseRequest], {})).toEqual({
      "request-1": "child-1",
    });
    expect(buildInitialRequestNotificationParents([baseRequest], {})).toEqual({
      "request-1": "parent-1",
    });
  });

  it("defaults same-email adult requests to create when no matches exist", () => {
    const adultRequest: FamilyGroupRequest = {
      ...baseRequest,
      id: "request-2",
      type: "ADULT_REQUEST",
      childFirstName: null,
      childLastName: null,
      requestedFirstName: "Carla",
      requestedLastName: "Adult",
      requestedEmail: "ada@example.com",
      matchingMembers: [],
    };

    expect(buildInitialRequestSelections([adultRequest], {})).toEqual({
      "request-2": "__create__",
    });
  });

  it("maps search results with child age-tier filtering and group membership flags", () => {
    const results = mapFamilyGroupRequestSearchResults(baseRequest, [
      {
        id: "child-2",
        firstName: "Bea",
        lastName: "Child",
        email: "bea@example.com",
        ageTier: "CHILD",
        active: true,
        canLogin: false,
        ageLabel: "8 years",
      },
      {
        id: "parent-1",
        firstName: "Ada",
        lastName: "Parent",
        email: "ada@example.com",
        ageTier: "ADULT",
        active: true,
        canLogin: true,
      },
    ]);

    expect(results).toEqual([
      {
        id: "child-2",
        firstName: "Bea",
        lastName: "Child",
        email: "bea@example.com",
        ageTier: "CHILD",
        active: true,
        canLogin: false,
        ageLabel: "8 years",
        parentLinks: [],
        alreadyInGroup: false,
      },
    ]);
  });

  it("keeps a searched row's parent links when it overwrites the same candidate", () => {
    // A search row wins over the same id from `matchingMembers`, so a search
    // response without `parentLinks` silently emptied the child-request
    // notification-recipient choices. The endpoint returns them; this pins that
    // the merge does not throw them away.
    const searched = mapFamilyGroupRequestSearchResults(baseRequest, [
      {
        id: "child-1",
        firstName: "Bea",
        lastName: "Child",
        email: "bea@example.com",
        ageTier: "CHILD",
        active: true,
        canLogin: false,
        ageLabel: "8 years",
        parentLinks: [
          {
            id: "ann-1",
            firstName: "Ann",
            lastName: "Parent",
            email: "ann@example.com",
            parentLinkType: "PRIMARY",
          },
        ],
      },
    ]);

    const merged = mergeFamilyGroupRequestCandidates(baseRequest, searched);

    expect(merged).toHaveLength(1);
    expect(merged[0].parentLinks).toEqual([
      expect.objectContaining({ id: "ann-1", parentLinkType: "PRIMARY" }),
    ]);
  });

  it("builds shared-email clusters using effective email", () => {
    const members: FamilyGroupMemberRow[] = [
      {
        id: "adult-1",
        firstName: "Ada",
        lastName: "Parent",
        email: "ADA@EXAMPLE.COM",
        effectiveEmail: "ada@example.com",
        ageTier: "ADULT",
        active: true,
      },
      {
        id: "child-1",
        firstName: "Bea",
        lastName: "Child",
        email: "child@example.com",
        effectiveEmail: "ada@example.com",
        ageTier: "CHILD",
        active: true,
      },
      {
        id: "adult-2",
        firstName: "Cora",
        lastName: "Other",
        email: "cora@example.com",
        ageTier: "ADULT",
        active: true,
      },
    ];

    expect(buildSharedEmailClusters(members)).toEqual([
      {
        email: "ada@example.com",
        members: [members[0], members[1]],
      },
    ]);
  });

  it("summarizes removal requests with the subject member", () => {
    const removalRequest: FamilyGroupRequest = {
      ...baseRequest,
      id: "request-3",
      type: "REMOVAL_REQUEST",
      subjectMember: {
        id: "child-1",
        firstName: "Bea",
        lastName: "Child",
        email: "bea@example.com",
        ageTier: "CHILD",
        active: true,
      },
      matchingMembers: [],
    };

    expect(getFamilyGroupRequestSummary(removalRequest)).toBe(
      "Ada Parent wants to remove Bea Child from Parent Family."
    );
  });

  it("labels and summarizes GROUP_CREATE requests (#1681)", () => {
    const groupCreateRequest: FamilyGroupRequest = {
      ...baseRequest,
      id: "request-4",
      type: "GROUP_CREATE",
      familyGroup: { id: "group-new", name: "New Family", members: [] },
      invitedMember: {
        id: "partner-1",
        firstName: "Pat",
        lastName: "Partner",
        email: "pat@example.com",
      },
      matchingMembers: [],
    };

    expect(getFamilyGroupRequestTypeLabel(groupCreateRequest)).toBe(
      "New Family Group"
    );
    expect(getFamilyGroupRequestSummary(groupCreateRequest)).toBe(
      "Ada Parent wants to create the new family group New Family and invite Pat Partner."
    );
    expect(
      getFamilyGroupRequestSummary({ ...groupCreateRequest, invitedMember: null })
    ).toBe("Ada Parent wants to create the new family group New Family.");
    // GROUP_CREATE never seeds a member-record selection.
    expect(buildInitialRequestSelections([groupCreateRequest], {})).toEqual({});
  });
});

/*
  ONE HELPER BECAME TWO, and these two blocks are why (CT-4, #2870).

  #2256: `formatFamilyGroupDate` was a bare `toLocaleDateString()` — no locale,
  no time zone — so the six family-group surfaces that render through it showed
  "4/16/2026" to a US-locale admin and could show the wrong calendar day to any
  admin whose machine sat behind New Zealand. That fix pinned `APP_TIME_ZONE`
  for all of them, which is right for a request's `createdAt` and wrong for a
  date of birth: a calendar day has no timezone, and projecting the UTC-midnight
  encoding of one through a zone behind Greenwich names the day before.

  So there are now two helpers with two contracts, and the tests are split the
  same way. Both keep the "Not provided" placeholder and the never-throw
  contract: these values arrive over `fetch` with no runtime schema check and
  render inside a reviewer's queue, where a `RangeError` reaches the nearest
  error boundary and blanks the whole screen.

  WHAT THIS FILE CAN AND CANNOT SEE. `APP_TIME_ZONE` resolves to
  `Pacific/Auckland` under test, which is AHEAD of Greenwich — so projecting a
  UTC-midnight day through it lands on club midday, the SAME day, and a
  calendar-day assertion here cannot tell a correct implementation from one that
  projects through the CONFIGURED zone. `admin-calendar-day-helpers-west-of-utc.test.ts`
  is the file that can: it mocks the config module to a zone behind Greenwich for
  exactly that. What is checked below is the rendered shape, both spellings a
  `@db.Date` column reaches a browser in, independence from the HOST's own zone,
  and the placeholder contract.
*/
describe("formatFamilyGroupCalendarDay — a date of birth, with no zone", () => {
  const hostTimeZone = captureHostTimeZone();

  afterEach(() => {
    // A bare `delete process.env.TZ` does not invalidate Node's cached zone
    // (#2485) — `hostTimeZone.restore()` assigns the real host zone back
    // first, so it can't leak the fake one into a later test in this worker.
    hostTimeZone.restore();
  });

  it("renders a bare yyyy-MM-dd day in the app's standard medium format", () => {
    expect(formatFamilyGroupCalendarDay("2018-01-01")).toBe("1 Jan 2018");
    expect(formatFamilyGroupCalendarDay("2014-08-28")).toBe("28 Aug 2014");
  });

  it("renders the UTC-midnight spelling of the same day identically", () => {
    // The two shapes a `@db.Date` column reaches the browser in: Prisma's
    // serialised `Date`, and a bare day from a route that encoded it itself.
    // Both name one civil day, so a caller must not have to know which it holds.
    expect(formatFamilyGroupCalendarDay("2018-01-01T00:00:00.000Z")).toBe(
      "1 Jan 2018",
    );
    expect(formatFamilyGroupCalendarDay("2014-08-28T00:00:00.000Z")).toBe(
      "28 Aug 2014",
    );
  });

  it("ignores the HOST's time zone on both sides of the stored day", () => {
    // The mutant this kills is a formatter that dropped its `timeZone: "UTC"`
    // pin and so reads whatever the process resolves. New York is behind
    // Greenwich, where the UTC-midnight encoding reads as the PREVIOUS evening,
    // and Kiritimati is far ahead of it — no host-reading formatter answers
    // "1 Jan 2018" to both.
    process.env.TZ = "America/New_York";
    expect(formatFamilyGroupCalendarDay("2018-01-01T00:00:00.000Z")).toBe(
      "1 Jan 2018",
    );
    process.env.TZ = "Pacific/Kiritimati";
    expect(formatFamilyGroupCalendarDay("2018-01-01T00:00:00.000Z")).toBe(
      "1 Jan 2018",
    );
    process.env.TZ = "UTC";
    expect(formatFamilyGroupCalendarDay("2018-01-01T00:00:00.000Z")).toBe(
      "1 Jan 2018",
    );
  });

  it("keeps the placeholder for missing values and never throws on a bad one", () => {
    expect(formatFamilyGroupCalendarDay(null)).toBe("Not provided");
    expect(formatFamilyGroupCalendarDay(undefined)).toBe("Not provided");
    expect(formatFamilyGroupCalendarDay("")).toBe("Not provided");
    // `Intl.DateTimeFormat` throws RangeError on an invalid Date, which would
    // take the whole request-review card down; the guard degrades instead.
    expect(formatFamilyGroupCalendarDay("not-a-date")).toBe("Not provided");
    // A day that does not exist. Neither branch rolls it forward to 1 March:
    // the bare decoder refuses it, and the instant decoder refuses an ISO
    // string whose date part is not a real day.
    expect(formatFamilyGroupCalendarDay("2026-02-30")).toBe("Not provided");
    expect(formatFamilyGroupCalendarDay("2026-02-30T00:00:00.000Z")).toBe(
      "Not provided",
    );
    // A timestamp with NO offset names a wall-clock reading in whichever zone
    // happens to be reading it, which is the one thing neither decoder accepts.
    expect(formatFamilyGroupCalendarDay("2018-01-01T13:45:00")).toBe(
      "Not provided",
    );
  });
});

describe("formatFamilyGroupInstantDate — a Requested stamp, in the club's zone", () => {
  // 23:30 UTC on 15 April is 11:30 on the 16th in Auckland and 17:30 on the
  // 15th in Denver, so this one moment has two different civil dates to choose
  // between and the choice is the thing under test.
  const INSTANT = "2026-04-15T23:30:00.000Z";
  const denver = bindClubTime(requireClubTimeZone("America/Denver"));
  const auckland = bindClubTime(requireClubTimeZone("Pacific/Auckland"));
  const hostTimeZone = captureHostTimeZone();

  afterEach(() => {
    hostTimeZone.restore();
  });

  it("dates the instant in the BOUND zone, not in one zone for everybody", () => {
    // The literals are hand-written rather than recomputed through the kernel,
    // so a kernel defect cannot agree with itself here. A helper that ignored
    // its binding could not answer both.
    expect(formatFamilyGroupInstantDate(auckland, INSTANT)).toBe("16 Apr 2026");
    expect(formatFamilyGroupInstantDate(denver, INSTANT)).toBe("15 Apr 2026");
  });

  it("ignores the host's time zone, on either side of the club's day", () => {
    process.env.TZ = "Pacific/Kiritimati";
    expect(formatFamilyGroupInstantDate(denver, INSTANT)).toBe("15 Apr 2026");
    process.env.TZ = "America/New_York";
    expect(formatFamilyGroupInstantDate(auckland, INSTANT)).toBe("16 Apr 2026");
  });

  it("keeps the placeholder for missing values and never throws on a bad one", () => {
    expect(formatFamilyGroupInstantDate(auckland, null)).toBe("Not provided");
    expect(formatFamilyGroupInstantDate(auckland, undefined)).toBe(
      "Not provided",
    );
    expect(formatFamilyGroupInstantDate(auckland, "")).toBe("Not provided");
    expect(formatFamilyGroupInstantDate(auckland, "not-a-date")).toBe(
      "Not provided",
    );
    // An offset-free timestamp, and a bare calendar day, are both refused
    // rather than read in the reader's own zone. That refusal IS the contract:
    // this helper only ever renders a value that names a real moment.
    expect(formatFamilyGroupInstantDate(auckland, "2026-04-15T23:30:00")).toBe(
      "Not provided",
    );
    expect(formatFamilyGroupInstantDate(auckland, "2026-04-16")).toBe(
      "Not provided",
    );
  });
});
