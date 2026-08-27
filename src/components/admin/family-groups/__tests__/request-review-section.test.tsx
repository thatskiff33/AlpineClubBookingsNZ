// @vitest-environment jsdom

// `render` FROM THE SHARED HARNESS, not from Testing Library: since CT-4
// (#2870) the section reads the club's persisted zone from
// `ClubTimeProvider` and hands it to each card, and `useClubTime()` throws
// when no provider is mounted. The zone itself is not what this file is
// about — the card is stubbed out below — so the harness default is right
// here; `request-review-card-club-time.test.tsx` is where the zone is the
// subject and picks a divergent one.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FamilyGroupRequest,
  RequestMemberMatch,
} from "@/lib/admin-family-group-ui-helpers";
import type { FamilyGroupRequestReviewCardProps } from "@/components/admin/family-groups/request-review-card";

// The child card owns the rendering/UX; this section owns the state machine and
// the search/approve/reject fetches. Replace the card with a lightweight stub
// that surfaces the callback props as plain buttons/inputs and echoes the
// display props (selection, error, feedback) so the tests can drive the
// section's handlers and read back exactly what it passes down.
vi.mock("@/components/admin/family-groups/request-review-card", () => ({
  FamilyGroupRequestReviewCard: (props: FamilyGroupRequestReviewCardProps) => {
    const rid = props.request.id;
    return (
      <div data-testid={`card-${rid}`}>
        {/* The club zone the section handed this card, echoed so the
            section's ONE provider read is observable (CT-4, #2870). */}
        <div data-testid={`zone-${rid}`}>{props.clubTime.zone}</div>
        <div data-testid={`selection-${rid}`}>{props.requestSelection ?? ""}</div>
        <div data-testid={`error-${rid}`}>{props.requestError ?? ""}</div>
        <div data-testid={`feedback-${rid}`}>{props.requestSearchMessage ?? ""}</div>
        <div data-testid={`searching-${rid}`}>{String(props.searching)}</div>
        <div data-testid={`submitting-${rid}`}>{String(props.submitting)}</div>
        <div data-testid={`results-${rid}`}>{props.searchedMembers.length}</div>
        <input
          data-testid={`term-${rid}`}
          value={props.requestSearchTerm ?? ""}
          onChange={(event) => props.onSearchTermChange(event.target.value)}
        />
        <input
          data-testid={`note-${rid}`}
          value={props.requestNote ?? ""}
          onChange={(event) => props.onNoteChange(event.target.value)}
        />
        <input
          data-testid={`select-${rid}`}
          onChange={(event) => props.onSelectMember(event.target.value)}
        />
        <input
          data-testid={`notify-${rid}`}
          onChange={(event) => props.onNotificationParentChange(event.target.value)}
        />
        <button data-testid={`search-${rid}`} onClick={props.onSearchMembers}>
          search
        </button>
        <button data-testid={`approve-${rid}`} onClick={props.onApprove}>
          approve
        </button>
        <button data-testid={`reject-${rid}`} onClick={props.onReject}>
          reject
        </button>
      </div>
    );
  },
}));

import { FamilyGroupRequestReviewSection } from "@/components/admin/family-groups/request-review-section";
import { chooseDivergentClubZone } from "@/lib/__tests__/helpers/club-time-zone";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { CLUB_TIME_ZONE_FALLBACK } from "@/lib/club-time-zone";

const REQUESTER = {
  id: "parent-1",
  firstName: "Ada",
  lastName: "Parent",
  email: "ada@example.com",
};

function buildChildRequest(
  overrides: Partial<FamilyGroupRequest> = {}
): FamilyGroupRequest {
  return {
    id: "req-child",
    type: "CHILD_REQUEST",
    createdAt: "2026-05-01T00:00:00.000Z",
    requester: { ...REQUESTER },
    familyGroup: { id: "group-1", name: "Parent Family", members: [] },
    childFirstName: "Bea",
    childLastName: "Child",
    childDateOfBirth: "2018-01-01",
    matchingMembers: [],
    ...overrides,
  };
}

function buildAdultRequest(
  overrides: Partial<FamilyGroupRequest> = {}
): FamilyGroupRequest {
  return {
    id: "req-adult",
    type: "ADULT_REQUEST",
    createdAt: "2026-05-01T00:00:00.000Z",
    requester: { ...REQUESTER },
    familyGroup: { id: "group-1", name: "Parent Family", members: [] },
    requestedFirstName: "Carla",
    requestedLastName: "Adult",
    requestedEmail: "ada@example.com",
    matchingMembers: [],
    ...overrides,
  };
}

function buildMatch(overrides: Partial<RequestMemberMatch> = {}): RequestMemberMatch {
  return {
    id: "child-1",
    firstName: "Bea",
    lastName: "Child",
    email: "ada@example.com",
    ageTier: "CHILD",
    active: true,
    canLogin: false,
    ageLabel: "8 years",
    alreadyInGroup: false,
    parentLinks: [],
    ...overrides,
  };
}

/**
 * A raw row from GET /api/admin/family-groups/member-search
 * (FamilyGroupRequestSearchResult). #2568: `ageLabel`, never a date of birth.
 */
function buildSearchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "child-2",
    firstName: "Bea",
    lastName: "Child",
    email: "bea@example.com",
    ageTier: "CHILD",
    active: true,
    canLogin: false,
    ageLabel: "8 years",
    ...overrides,
  };
}

function stubFetch(response: { ok: boolean; body?: unknown }) {
  const fetchMock = vi.fn();
  fetchMock.mockResolvedValue({
    ok: response.ok,
    json: async () => response.body ?? {},
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

/** Parse the JSON body of the fetch call at `index`. */
function fetchBody(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const init = fetchMock.mock.calls[index][1] as RequestInit;
  return JSON.parse(init.body as string);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("FamilyGroupRequestReviewSection - searchRequestMembers", () => {
  it("searches the members API with the child age-tier filter for a CHILD_REQUEST", async () => {
    const fetchMock = stubFetch({ ok: true, body: { members: [] } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest()]}
        onReviewed={vi.fn()}
        canEdit={true}
      />
    );

    fireEvent.change(screen.getByTestId("term-req-child"), {
      target: { value: "Bea" },
    });
    fireEvent.click(screen.getByTestId("search-req-child"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/admin/family-groups/member-search?q=Bea&ageTierIn=INFANT,CHILD,YOUTH"
    );
  });

  it("searches WITHOUT the age-tier filter for an ADULT_REQUEST", async () => {
    // A matching member keeps the adult from auto-seeding a `__create__`
    // selection, so this render only exercises the search URL.
    const fetchMock = stubFetch({ ok: true, body: { members: [] } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[
          buildAdultRequest({
            matchingMembers: [
              buildMatch({ id: "adult-9", ageTier: "ADULT", canLogin: true }),
            ],
          }),
        ]}
        onReviewed={vi.fn()}
        canEdit={true}
      />
    );

    fireEvent.change(screen.getByTestId("term-req-adult"), {
      target: { value: "Carla" },
    });
    fireEvent.click(screen.getByTestId("search-req-adult"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/admin/family-groups/member-search?q=Carla"
    );
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("ageTierIn");
  });

  it("rejects a query shorter than 2 characters and does not fetch", async () => {
    const fetchMock = stubFetch({ ok: true, body: { members: [] } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest()]}
        onReviewed={vi.fn()}
        canEdit={true}
      />
    );

    // A single-character term wins over the (>=2 char) subject name.
    fireEvent.change(screen.getByTestId("term-req-child"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByTestId("search-req-child"));

    await waitFor(() =>
      expect(screen.getByTestId("error-req-child").textContent).toBe(
        "Enter at least 2 characters to search for an existing member record."
      )
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("auto-selects a single match and reports it", async () => {
    stubFetch({ ok: true, body: { members: [buildSearchRow({ id: "child-2" })] } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest()]}
        onReviewed={vi.fn()}
        canEdit={true}
      />
    );

    fireEvent.change(screen.getByTestId("term-req-child"), {
      target: { value: "Bea" },
    });
    fireEvent.click(screen.getByTestId("search-req-child"));

    await waitFor(() =>
      expect(screen.getByTestId("selection-req-child").textContent).toBe("child-2")
    );
    expect(screen.getByTestId("feedback-req-child").textContent).toBe(
      "Found and selected Bea Child."
    );
    expect(screen.getByTestId("results-req-child").textContent).toBe("1");
  });

  it("reports when no eligible member records are found", async () => {
    stubFetch({ ok: true, body: { members: [] } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest()]}
        onReviewed={vi.fn()}
        canEdit={true}
      />
    );

    fireEvent.change(screen.getByTestId("term-req-child"), {
      target: { value: "Zzz" },
    });
    fireEvent.click(screen.getByTestId("search-req-child"));

    await waitFor(() =>
      expect(screen.getByTestId("feedback-req-child").textContent).toBe(
        'No eligible member records found for "Zzz".'
      )
    );
  });

  it("surfaces the API error on a failed search", async () => {
    stubFetch({ ok: false, body: { error: "Search blew up" } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest()]}
        onReviewed={vi.fn()}
        canEdit={true}
      />
    );

    fireEvent.change(screen.getByTestId("term-req-child"), {
      target: { value: "Bea" },
    });
    fireEvent.click(screen.getByTestId("search-req-child"));

    await waitFor(() =>
      expect(screen.getByTestId("error-req-child").textContent).toBe("Search blew up")
    );
  });

  it("falls back to a generic search error when the response has no error", async () => {
    stubFetch({ ok: false, body: {} });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest()]}
        onReviewed={vi.fn()}
        canEdit={true}
      />
    );

    fireEvent.change(screen.getByTestId("term-req-child"), {
      target: { value: "Bea" },
    });
    fireEvent.click(screen.getByTestId("search-req-child"));

    await waitFor(() =>
      expect(screen.getByTestId("error-req-child").textContent).toBe(
        "Failed to search member records."
      )
    );
  });
});

describe("FamilyGroupRequestReviewSection - handleRequest", () => {
  it("blocks approve without a member selection and does not PUT (member noun)", async () => {
    const fetchMock = stubFetch({ ok: true, body: {} });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest()]}
        onReviewed={vi.fn()}
        canEdit={true}
      />
    );

    fireEvent.click(screen.getByTestId("approve-req-child"));

    await waitFor(() =>
      expect(screen.getByTestId("error-req-child").textContent).toBe(
        "Choose the member record to link, or create a new non-login member where available."
      )
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the configured 'adult' noun in the selection guard", async () => {
    stubFetch({ ok: true, body: {} });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest()]}
        onReviewed={vi.fn()}
        canEdit={true}
        createMemberNoun="adult"
      />
    );

    fireEvent.click(screen.getByTestId("approve-req-child"));

    await waitFor(() =>
      expect(screen.getByTestId("error-req-child").textContent).toBe(
        "Choose the member record to link, or create a new non-login adult where available."
      )
    );
  });

  it("approves a CHILD_REQUEST with the linked member and inherited email; calls onReviewed once", async () => {
    const onReviewed = vi.fn();
    const fetchMock = stubFetch({ ok: true, body: { success: true } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest({ matchingMembers: [buildMatch()] })]}
        onReviewed={onReviewed}
        canEdit={true}
      />
    );

    // The single matching member is auto-seeded as the selection.
    expect(screen.getByTestId("selection-req-child").textContent).toBe("child-1");

    // #1789: a CHILD_REQUEST decision emails the requester, so approve opens the
    // notify-choice dialog first and does not PUT until a choice is made.
    fireEvent.click(screen.getByTestId("approve-req-child"));
    expect(fetchMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText("Email the member about this approval?")).toBeTruthy()
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Approve and email member" })
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/family-groups/requests");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PUT");
    expect(fetchBody(fetchMock)).toEqual({
      requestId: "req-child",
      action: "approve",
      linkedMemberId: "child-1",
      inheritEmailFromId: "parent-1",
      notifyMember: true,
    });
    await waitFor(() => expect(onReviewed).toHaveBeenCalledTimes(1));
  });

  it("suppresses the requester email on 'Approve without emailing' (#1789)", async () => {
    const onReviewed = vi.fn();
    const fetchMock = stubFetch({ ok: true, body: { success: true } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest({ matchingMembers: [buildMatch()] })]}
        onReviewed={onReviewed}
        canEdit={true}
      />
    );

    fireEvent.click(screen.getByTestId("approve-req-child"));
    await waitFor(() =>
      expect(screen.getByText("Email the member about this approval?")).toBeTruthy()
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Approve without emailing" })
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchBody(fetchMock)).toEqual({
      requestId: "req-child",
      action: "approve",
      linkedMemberId: "child-1",
      inheritEmailFromId: "parent-1",
      notifyMember: false,
    });
    await waitFor(() => expect(onReviewed).toHaveBeenCalledTimes(1));
  });

  it("passes a chosen notification parent as inheritEmailFromId", async () => {
    const fetchMock = stubFetch({ ok: true, body: { success: true } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest({ matchingMembers: [buildMatch()] })]}
        onReviewed={vi.fn()}
        canEdit={true}
      />
    );

    fireEvent.change(screen.getByTestId("notify-req-child"), {
      target: { value: "grandparent-1" },
    });
    fireEvent.click(screen.getByTestId("approve-req-child"));
    await waitFor(() =>
      expect(screen.getByText("Email the member about this approval?")).toBeTruthy()
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Approve and email member" })
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchBody(fetchMock).inheritEmailFromId).toBe("grandparent-1");
  });

  it("approves with createNewMember when the '__create__' option is selected", async () => {
    const fetchMock = stubFetch({ ok: true, body: { success: true } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest()]}
        onReviewed={vi.fn()}
        canEdit={true}
      />
    );

    fireEvent.change(screen.getByTestId("select-req-child"), {
      target: { value: "__create__" },
    });
    fireEvent.click(screen.getByTestId("approve-req-child"));
    await waitFor(() =>
      expect(screen.getByText("Email the member about this approval?")).toBeTruthy()
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Approve and email member" })
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = fetchBody(fetchMock);
    expect(body).toEqual({
      requestId: "req-child",
      action: "approve",
      createNewMember: true,
      notifyMember: true,
    });
    expect(body).not.toHaveProperty("linkedMemberId");
    expect(body).not.toHaveProperty("inheritEmailFromId");
  });

  it("rejects with a rejection reason when a note is present", async () => {
    const onReviewed = vi.fn();
    const fetchMock = stubFetch({ ok: true, body: { success: true } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest()]}
        onReviewed={onReviewed}
        canEdit={true}
      />
    );

    fireEvent.change(screen.getByTestId("note-req-child"), {
      target: { value: "  Not eligible  " },
    });
    fireEvent.click(screen.getByTestId("reject-req-child"));
    await waitFor(() =>
      expect(screen.getByText("Email the member about this rejection?")).toBeTruthy()
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reject and email member" })
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PUT");
    expect(fetchBody(fetchMock)).toEqual({
      requestId: "req-child",
      action: "reject",
      rejectionReason: "Not eligible",
      notifyMember: true,
    });
    await waitFor(() => expect(onReviewed).toHaveBeenCalledTimes(1));
  });

  it("omits the rejection reason when no note is entered", async () => {
    const fetchMock = stubFetch({ ok: true, body: { success: true } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest()]}
        onReviewed={vi.fn()}
        canEdit={true}
      />
    );

    fireEvent.click(screen.getByTestId("reject-req-child"));
    await waitFor(() =>
      expect(screen.getByText("Email the member about this rejection?")).toBeTruthy()
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reject and email member" })
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = fetchBody(fetchMock);
    expect(body).toEqual({
      requestId: "req-child",
      action: "reject",
      notifyMember: true,
    });
    expect(body).not.toHaveProperty("rejectionReason");
  });

  it("surfaces the API error and skips onReviewed on a failed review", async () => {
    const onReviewed = vi.fn();
    stubFetch({ ok: false, body: { error: "Conflict" } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest({ matchingMembers: [buildMatch()] })]}
        onReviewed={onReviewed}
        canEdit={true}
      />
    );

    fireEvent.click(screen.getByTestId("approve-req-child"));
    await waitFor(() =>
      expect(screen.getByText("Email the member about this approval?")).toBeTruthy()
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Approve and email member" })
    );

    await waitFor(() =>
      expect(screen.getByTestId("error-req-child").textContent).toBe("Conflict")
    );
    expect(onReviewed).not.toHaveBeenCalled();
  });

  it("falls back to a generic review error when the response has no error", async () => {
    const onReviewed = vi.fn();
    stubFetch({ ok: false, body: {} });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest({ matchingMembers: [buildMatch()] })]}
        onReviewed={onReviewed}
        canEdit={true}
      />
    );

    fireEvent.click(screen.getByTestId("approve-req-child"));
    await waitFor(() =>
      expect(screen.getByText("Email the member about this approval?")).toBeTruthy()
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Approve and email member" })
    );

    await waitFor(() =>
      expect(screen.getByTestId("error-req-child").textContent).toBe(
        "Failed to approve request."
      )
    );
    expect(onReviewed).not.toHaveBeenCalled();
  });
});

describe("FamilyGroupRequestReviewSection - notify choice dialog (#1789)", () => {
  function buildGroupCreateRequest(
    overrides: Partial<FamilyGroupRequest> = {}
  ): FamilyGroupRequest {
    return {
      id: "req-gc",
      type: "GROUP_CREATE",
      createdAt: "2026-05-01T00:00:00.000Z",
      requester: { ...REQUESTER },
      familyGroup: { id: "group-new", name: "Parent Family", members: [] },
      matchingMembers: [],
      ...overrides,
    };
  }

  it("shows partner-invite-truthful copy on a GROUP_CREATE approval and threads notifyMember: false", async () => {
    const fetchMock = stubFetch({ ok: true, body: { success: true } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildGroupCreateRequest({ invitedMemberId: "partner-1" })]}
        onReviewed={vi.fn()}
        canEdit={true}
      />
    );

    fireEvent.click(screen.getByTestId("approve-req-gc"));
    // No PUT until the admin answers the dialog.
    expect(fetchMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText("Email the member about this approval?")).toBeTruthy()
    );
    // The copy stays truthful: the requester notice can be suppressed, but the
    // partner invitation is always sent.
    expect(
      screen.getByText(/partner invitation is always sent/i)
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Approve without emailing" })
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchBody(fetchMock)).toEqual({
      requestId: "req-gc",
      action: "approve",
      notifyMember: false,
    });
  });

  it("submits a non-emailing decision directly, with no dialog and no notifyMember flag", async () => {
    const fetchMock = stubFetch({ ok: true, body: { success: true } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[
          buildChildRequest({ id: "req-join", type: "JOIN_REQUEST" }),
        ]}
        onReviewed={vi.fn()}
        canEdit={true}
      />
    );

    fireEvent.click(screen.getByTestId("approve-req-join"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The notify dialog never appears for a request type that emails no one.
    expect(screen.queryByText("Email the member about this approval?")).toBeNull();
    const body = fetchBody(fetchMock);
    expect(body).toEqual({ requestId: "req-join", action: "approve" });
    expect(body).not.toHaveProperty("notifyMember");
  });
});

/*
  THE SECTION IS THE ONE PLACE IN THIS FEATURE THAT READS THE PROVIDER, and until
  this block existed nothing checked that it did (CT-4, #2870; `INV-CONFIG-002`).

  MEASURED on this branch: replacing `useClubTime()` here with a hard-coded
  `bindClubTime("Pacific/Auckland")` failed 0 of the 107 tests across the seven
  suites this change touches. That is the structural blindness recorded on #2870
  — every suite above renders under the harness's default zone, which is
  deliberately the one the environment also resolves to, so none of them can tell
  the persisted zone from the environment however many dates they assert.

  What closes it is an identity check under a zone the section could not have
  guessed: mount the provider with it, and read back the zone each card was
  handed.
*/
describe("FamilyGroupRequestReviewSection - the club zone it hands each card", () => {
  /*
    A zone that is neither the environment's nor the provider's documented
    fallback, so neither plausible hard-code can produce it. The answer here IS
    the zone identifier — the observable is which binding the card received, not
    a formatted value — which is why `answerFor` is the identity and each case
    repeats its own zone under a second key: `answerKey` may not be `zone`
    itself, and the chooser checks the pinned literal against the answer before
    choosing.
  */
  const chosen = chooseDivergentClubZone({
    subject: "the club zone the review section hands each card",
    answerKey: "identifier",
    cases: [
      { zone: "America/Denver", identifier: "America/Denver" },
      { zone: "Pacific/Kiritimati", identifier: "Pacific/Kiritimati" },
    ],
    answerFor: (zone) => zone,
    alsoDifferFrom: [CLUB_TIME_ZONE_FALLBACK],
  });

  function renderUnderChosenZone(requests: FamilyGroupRequest[]) {
    return render(
      <FamilyGroupRequestReviewSection
        requests={requests}
        onReviewed={vi.fn()}
        canEdit={true}
      />,
      {
        // Replaces the harness's default provider — the point of this block is
        // that the zone is NOT the default one.
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <ClubTimeProvider zone={chosen.zone}>{children}</ClubTimeProvider>
        ),
      }
    );
  }

  it("passes the PERSISTED zone down, not the environment's or a literal", () => {
    renderUnderChosenZone([buildChildRequest()]);

    expect(screen.getByTestId("zone-req-child").textContent).toBe(
      chosen.identifier
    );
  });

  it("hands every card in the queue the same binding, read once", () => {
    // The reason the card takes a prop rather than calling the hook itself: a
    // queue of forty requests must construct one binding, not forty. Identity
    // is what proves "once" — a per-card `bindClubTime` would produce equal
    // zones but different objects, so the zone is checked on every card and the
    // shared-instance claim rests on there being a single `useClubTime()` call
    // in the section.
    renderUnderChosenZone([
      buildChildRequest(),
      buildChildRequest({ id: "req-child-2" }),
      buildChildRequest({ id: "req-child-3" }),
    ]);

    for (const id of ["req-child", "req-child-2", "req-child-3"]) {
      expect(screen.getByTestId(`zone-${id}`).textContent).toBe(
        chosen.identifier
      );
    }
  });
});
