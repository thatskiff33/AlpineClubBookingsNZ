// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFamilyGroupRequestReview } from "@/hooks/use-family-group-request-review";
import type { FamilyGroupRequest } from "@/lib/admin-family-group-ui-helpers";

const childRequest: FamilyGroupRequest = {
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
      dateOfBirth: "2018-01-01",
      alreadyInGroup: false,
      parentLinks: [],
    },
  ],
};

const options = {
  onRefresh: vi.fn().mockResolvedValue(undefined),
  missingSelectionError: "pick a member record",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("useFamilyGroupRequestReview", () => {
  it("builds the shared review-card props (removal details on, no surface-specific bits)", () => {
    const { result } = renderHook(() => useFamilyGroupRequestReview(options));

    const props = result.current.getRequestReviewCardProps(childRequest);
    expect(props.request).toBe(childRequest);
    expect(props.showRemovalDetails).toBe(true);
    // The list/editor add these themselves; the shared props must not carry them.
    expect(props).not.toHaveProperty("idPrefix");
    expect(props).not.toHaveProperty("showSearchGuidance");
    expect(props.searchedMembers).toEqual([]);
    expect(props.searching).toBe(false);
    expect(props.submitting).toBe(false);
  });

  it("initializeRequestState seeds child selection + notification parent defaults", () => {
    const { result } = renderHook(() => useFamilyGroupRequestReview(options));

    act(() => {
      result.current.initializeRequestState([childRequest]);
    });

    const props = result.current.getRequestReviewCardProps(childRequest);
    expect(props.requestSelection).toBe("child-1");
    expect(props.requestNotificationParentId).toBe("parent-1");
  });

  it("blocks an approve with no selection using the caller-supplied error copy", async () => {
    const { result } = renderHook(() => useFamilyGroupRequestReview(options));
    const adultRequest: FamilyGroupRequest = {
      ...childRequest,
      id: "request-2",
      type: "ADULT_REQUEST",
      matchingMembers: [],
    };

    await act(async () => {
      await result.current.handleRequest(adultRequest, "approve");
    });

    expect(options.onRefresh).not.toHaveBeenCalled();
    expect(
      result.current.getRequestReviewCardProps(adultRequest).requestError
    ).toBe("pick a member record");
  });

  it("searchRequestMembers maps eligible results and auto-selects a single match", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        members: [
          {
            id: "child-2",
            firstName: "Bea",
            lastName: "Child",
            email: "bea@example.com",
            ageTier: "CHILD",
            active: true,
            canLogin: false,
            dateOfBirth: "2018-01-01",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFamilyGroupRequestReview(options));

    await act(async () => {
      await result.current.searchRequestMembers(childRequest);
    });

    const props = result.current.getRequestReviewCardProps(childRequest);
    expect(props.searchedMembers.map((member) => member.id)).toEqual(["child-2"]);
    expect(props.requestSelection).toBe("child-2");
  });

  it("refreshes the surface after a successful approve/reject", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFamilyGroupRequestReview(options));
    const joinRequest: FamilyGroupRequest = {
      ...childRequest,
      id: "request-3",
      type: "JOIN_REQUEST",
      matchingMembers: [],
    };

    await act(async () => {
      await result.current.handleRequest(joinRequest, "approve");
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/family-groups/requests",
      expect.objectContaining({ method: "PUT" })
    );
    expect(options.onRefresh).toHaveBeenCalledTimes(1);
  });
});
