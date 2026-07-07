// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    dateOfBirth: "2018-01-01",
    alreadyInGroup: false,
    parentLinks: [],
    ...overrides,
  };
}

/** A raw /api/admin/members search-result row (FamilyGroupRequestSearchResult). */
function buildSearchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "child-2",
    firstName: "Bea",
    lastName: "Child",
    email: "bea@example.com",
    ageTier: "CHILD",
    active: true,
    canLogin: false,
    dateOfBirth: "2018-01-01",
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
      />
    );

    fireEvent.change(screen.getByTestId("term-req-child"), {
      target: { value: "Bea" },
    });
    fireEvent.click(screen.getByTestId("search-req-child"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/admin/members?q=Bea&active=true&pageSize=10&ageTierIn=INFANT,CHILD,YOUTH"
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
      />
    );

    fireEvent.change(screen.getByTestId("term-req-adult"), {
      target: { value: "Carla" },
    });
    fireEvent.click(screen.getByTestId("search-req-adult"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/admin/members?q=Carla&active=true&pageSize=10"
    );
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("ageTierIn");
  });

  it("rejects a query shorter than 2 characters and does not fetch", async () => {
    const fetchMock = stubFetch({ ok: true, body: { members: [] } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest()]}
        onReviewed={vi.fn()}
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
      />
    );

    // The single matching member is auto-seeded as the selection.
    expect(screen.getByTestId("selection-req-child").textContent).toBe("child-1");

    fireEvent.click(screen.getByTestId("approve-req-child"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/family-groups/requests");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PUT");
    expect(fetchBody(fetchMock)).toEqual({
      requestId: "req-child",
      action: "approve",
      linkedMemberId: "child-1",
      inheritEmailFromId: "parent-1",
    });
    await waitFor(() => expect(onReviewed).toHaveBeenCalledTimes(1));
  });

  it("passes a chosen notification parent as inheritEmailFromId", async () => {
    const fetchMock = stubFetch({ ok: true, body: { success: true } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest({ matchingMembers: [buildMatch()] })]}
        onReviewed={vi.fn()}
      />
    );

    fireEvent.change(screen.getByTestId("notify-req-child"), {
      target: { value: "grandparent-1" },
    });
    fireEvent.click(screen.getByTestId("approve-req-child"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchBody(fetchMock).inheritEmailFromId).toBe("grandparent-1");
  });

  it("approves with createNewMember when the '__create__' option is selected", async () => {
    const fetchMock = stubFetch({ ok: true, body: { success: true } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest()]}
        onReviewed={vi.fn()}
      />
    );

    fireEvent.change(screen.getByTestId("select-req-child"), {
      target: { value: "__create__" },
    });
    fireEvent.click(screen.getByTestId("approve-req-child"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = fetchBody(fetchMock);
    expect(body).toEqual({
      requestId: "req-child",
      action: "approve",
      createNewMember: true,
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
      />
    );

    fireEvent.change(screen.getByTestId("note-req-child"), {
      target: { value: "  Not eligible  " },
    });
    fireEvent.click(screen.getByTestId("reject-req-child"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PUT");
    expect(fetchBody(fetchMock)).toEqual({
      requestId: "req-child",
      action: "reject",
      rejectionReason: "Not eligible",
    });
    await waitFor(() => expect(onReviewed).toHaveBeenCalledTimes(1));
  });

  it("omits the rejection reason when no note is entered", async () => {
    const fetchMock = stubFetch({ ok: true, body: { success: true } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest()]}
        onReviewed={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId("reject-req-child"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = fetchBody(fetchMock);
    expect(body).toEqual({ requestId: "req-child", action: "reject" });
    expect(body).not.toHaveProperty("rejectionReason");
  });

  it("surfaces the API error and skips onReviewed on a failed review", async () => {
    const onReviewed = vi.fn();
    stubFetch({ ok: false, body: { error: "Conflict" } });
    render(
      <FamilyGroupRequestReviewSection
        requests={[buildChildRequest({ matchingMembers: [buildMatch()] })]}
        onReviewed={onReviewed}
      />
    );

    fireEvent.click(screen.getByTestId("approve-req-child"));

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
      />
    );

    fireEvent.click(screen.getByTestId("approve-req-child"));

    await waitFor(() =>
      expect(screen.getByTestId("error-req-child").textContent).toBe(
        "Failed to approve request."
      )
    );
    expect(onReviewed).not.toHaveBeenCalled();
  });
});
