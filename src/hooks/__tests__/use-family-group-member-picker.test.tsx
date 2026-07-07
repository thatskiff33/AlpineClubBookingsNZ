// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFamilyGroupMemberPicker } from "@/hooks/use-family-group-member-picker";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("useFamilyGroupMemberPicker", () => {
  it("adds and removes members, clearing the search box on add", () => {
    const { result } = renderHook(() => useFamilyGroupMemberPicker());

    act(() => {
      result.current.setMemberSearch("ada");
    });
    act(() => {
      result.current.addMember({
        id: "m1",
        firstName: "Ada",
        lastName: "Parent",
        email: "ada@example.com",
      });
    });

    expect(result.current.selectedMembers.map((member) => member.id)).toEqual(["m1"]);
    expect(result.current.memberSearch).toBe("");
    expect(result.current.searchResults).toEqual([]);

    act(() => {
      result.current.removeMember("m1");
    });
    expect(result.current.selectedMembers).toEqual([]);
  });

  it("debounced search fetches primary members and drops already-selected ids", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        members: [
          { id: "m1", firstName: "Ada", lastName: "Parent", email: "ada@example.com" },
          { id: "m2", firstName: "Bob", lastName: "Other", email: "bob@example.com" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFamilyGroupMemberPicker());

    act(() => {
      result.current.setSelectedMembers([
        { id: "m1", firstName: "Ada", lastName: "Parent", email: "ada@example.com" },
      ]);
    });
    act(() => {
      result.current.setMemberSearch("ada");
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current.searchResults.map((member) => member.id)).toEqual(["m2"])
    );

    const requestedUrl = fetchMock.mock.calls[0][0] as string;
    expect(requestedUrl).toContain("type=primary");
    expect(requestedUrl).toContain("active=true");
  });

  it("clears results without fetching for queries shorter than two characters", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFamilyGroupMemberPicker());

    act(() => {
      result.current.setMemberSearch("a");
    });

    await waitFor(() => expect(result.current.searchResults).toEqual([]));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
