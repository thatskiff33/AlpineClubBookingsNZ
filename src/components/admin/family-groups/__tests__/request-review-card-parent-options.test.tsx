// @vitest-environment jsdom

// Testing Library directly rather than the club-time harness, for the reason
// `request-review-card-age.test.tsx` states: the card takes its binding as a
// prop and consumes no provider (CT-4, #2870).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FamilyGroupRequestReviewCard } from "@/components/admin/family-groups/request-review-card";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { CLUB_TIME_TEST_ZONE } from "@/lib/__tests__/support/club-time-render";
import type {
  FamilyGroupRequest,
  RequestMemberMatch,
} from "@/lib/admin-family-group-ui-helpers";

/**
 * The child-request "Notification email recipient" choices (#2568 review).
 *
 * The value chosen here is submitted as `inheritEmailFromId` and decides which
 * parent's mailbox the child inherits, so the option list is a correctness
 * surface rather than a convenience. It is built from the SELECTED candidate's
 * `parentLinks`, and a searched candidate overwrites the same id that arrived
 * with the request — so a search response that omits the links removes the
 * child's real parent from the list, leaving only the requester, whose chain may
 * have no reachable mailbox at all (a 422 NO_INHERITABLE_EMAIL_SOURCE on
 * approval).
 */

afterEach(cleanup);

/** The harness default zone; the option list this file asserts carries no date. */
const CLUB_TIME = bindClubTime(requireClubTimeZone(CLUB_TIME_TEST_ZONE));

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

/** Bob raised the request; Ann is the child's primary parent. */
const REQUESTER = {
  id: "bob-1",
  firstName: "Bob",
  lastName: "Smith",
  email: "bob@no-email.invalid",
  ageLabel: "48 years",
};

function buildSearchedChild(
  overrides: Partial<RequestMemberMatch> = {}
): RequestMemberMatch {
  return {
    id: "ivy-1",
    firstName: "Ivy",
    lastName: "Smith",
    email: "smiths@example.com",
    ageTier: "CHILD",
    active: true,
    canLogin: false,
    ageLabel: "8 years",
    alreadyInGroup: false,
    parentLinks: [
      {
        id: "ann-1",
        firstName: "Ann",
        lastName: "Smith",
        email: "ann@example.com",
        parentLinkType: "PRIMARY",
      },
    ],
    ...overrides,
  };
}

function renderCard(candidate: RequestMemberMatch) {
  const request: FamilyGroupRequest = {
    id: "req-child",
    type: "CHILD_REQUEST",
    createdAt: "2026-06-01T00:00:00.000Z",
    requester: { ...REQUESTER },
    familyGroup: { id: "group-1", name: "Smith Family", members: [] },
    childFirstName: "Ivy",
    childLastName: "Smith",
    childDateOfBirth: "2018-01-01",
    childAgeLabel: "8 years",
    matchingMembers: [],
  };

  return render(
    <FamilyGroupRequestReviewCard
      request={request}
      clubTime={CLUB_TIME}
      searchedMembers={[candidate]}
      requestSelection={candidate.id}
      searching={false}
      submitting={false}
      canEdit
      {...noopHandlers}
    />
  );
}

function notificationOptionText() {
  const select = screen.getByLabelText("Notification email recipient");
  return Array.from(select.querySelectorAll("option")).map(
    (option) => option.textContent ?? ""
  );
}

describe("request review card — notification email recipients", () => {
  it("offers the selected candidate's recorded parent, not only the requester", () => {
    renderCard(buildSearchedChild());

    const options = notificationOptionText();
    expect(options).toContain("Ann Smith");
    expect(options).toContain("Bob Smith");
    expect(options).toContain("Use child's own email");
  });

  it("falls back to the requester alone when the candidate has no recorded parents", () => {
    renderCard(buildSearchedChild({ parentLinks: [] }));

    const options = notificationOptionText();
    expect(options).toEqual(["Use child's own email", "Bob Smith"]);
  });
});
