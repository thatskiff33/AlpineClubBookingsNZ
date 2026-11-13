// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  useWorkPartyPrefill,
  WORK_PARTY_PREFILL_LODGE_NOTICE,
  WORK_PARTY_PREFILL_UNAVAILABLE_NOTICE,
} from "../use-work-party-prefill";

/**
 * Fork #118: `/book?workParty=<id>` fills in the stay from the SERVER's join
 * stay, selects the work party's lodge, and ticks the working bee once. The
 * wizard's own handlers are spies here; the hook never reads dates from the URL.
 */
const fetchMock = vi.fn();

function workPartyResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => ({
      workParty: {
        id: "wp-1",
        name: "Spring",
        lodgeId: "lodge-2",
        join: { checkIn: "2026-07-10", checkOut: "2026-07-13" },
        ...overrides,
      },
    }),
  };
}

type Props = Parameters<typeof useWorkPartyPrefill>[0];

function setup(initial: Partial<Props> = {}) {
  const selectLodge = vi.fn();
  const selectDates = vi.fn();
  const props: Props = {
    workPartyId: "wp-1",
    lodgeIds: ["lodge-1", "lodge-2"],
    lodgesSettled: true,
    lodgeId: null,
    scopedLodgeId: null,
    onDatesStep: true,
    memberStarted: false,
    bookingBlocked: false,
    selectLodge,
    selectDates,
    ...initial,
  };
  const hook = renderHook((p: Props) => useWorkPartyPrefill(p), {
    initialProps: props,
  });
  return { hook, props, selectLodge, selectDates };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("useWorkPartyPrefill", () => {
  it("does nothing without ?workParty", () => {
    const { selectDates } = setup({ workPartyId: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(selectDates).not.toHaveBeenCalled();
  });

  it("selects the lodge, then the server's stay once that lodge is in scope", async () => {
    fetchMock.mockResolvedValue(workPartyResponse());
    const { hook, props, selectLodge, selectDates } = setup();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/work-parties/wp-1",
      expect.any(Object),
    );
    await waitFor(() => expect(selectLodge).toHaveBeenCalledWith("lodge-2"));
    expect(selectDates).not.toHaveBeenCalled();

    hook.rerender({ ...props, lodgeId: "lodge-2", scopedLodgeId: "lodge-2" });
    await waitFor(() =>
      expect(selectDates).toHaveBeenCalledWith("2026-07-10", "2026-07-13"),
    );
    hook.rerender({ ...props, lodgeId: "lodge-2", scopedLodgeId: "lodge-2" });
    expect(selectDates).toHaveBeenCalledTimes(1);
  });

  it("ticks the work party once, only when it is listed for the stay", async () => {
    fetchMock.mockResolvedValue(workPartyResponse({ lodgeId: null }));
    const { hook } = setup({ scopedLodgeId: "lodge-1", lodgeId: "lodge-1" });
    await waitFor(() =>
      expect(hook.result.current.workPartyPrefillName).toBe("Spring"),
    );
    let picked: string | null = null;
    act(() => {
      picked = hook.result.current.takePendingWorkPartySelection([
        { id: "other" },
        { id: "wp-1" },
      ]);
    });
    expect(picked).toBe("wp-1");
    expect(
      hook.result.current.takePendingWorkPartySelection([{ id: "wp-1" }]),
    ).toBeNull();
  });

  it("keeps the member's lodge for a club-wide work party", async () => {
    fetchMock.mockResolvedValue(workPartyResponse({ lodgeId: null }));
    const { selectLodge, selectDates } = setup({
      lodgeId: "lodge-1",
      scopedLodgeId: "lodge-1",
    });
    await waitFor(() =>
      expect(selectDates).toHaveBeenCalledWith("2026-07-10", "2026-07-13"),
    );
    expect(selectLodge).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown, inactive or hidden work party (404)", { ok: false, json: async () => ({}) }],
    ["a finished work party (no join stay)", workPartyResponse({ join: null })],
  ])("shows a notice and fills nothing in for %s", async (_label, response) => {
    fetchMock.mockResolvedValue(response);
    const { hook, selectLodge, selectDates } = setup({ scopedLodgeId: "lodge-1" });
    await waitFor(() =>
      expect(hook.result.current.workPartyPrefillNotice).toBe(
        WORK_PARTY_PREFILL_UNAVAILABLE_NOTICE,
      ),
    );
    expect(selectLodge).not.toHaveBeenCalled();
    expect(selectDates).not.toHaveBeenCalled();
  });

  it("refuses a lodge the member cannot book", async () => {
    fetchMock.mockResolvedValue(workPartyResponse({ lodgeId: "lodge-9" }));
    const { hook, selectLodge, selectDates } = setup({ scopedLodgeId: "lodge-1" });
    await waitFor(() =>
      expect(hook.result.current.workPartyPrefillNotice).toBe(
        WORK_PARTY_PREFILL_LODGE_NOTICE,
      ),
    );
    expect(selectLodge).not.toHaveBeenCalled();
    expect(selectDates).not.toHaveBeenCalled();
    expect(
      hook.result.current.takePendingWorkPartySelection([{ id: "wp-1" }]),
    ).toBeNull();
  });

  it("waits for the dates step", async () => {
    fetchMock.mockResolvedValue(workPartyResponse({ lodgeId: null }));
    const { hook, props, selectDates } = setup({
      scopedLodgeId: "lodge-1",
      onDatesStep: false,
    });
    await waitFor(() =>
      expect(hook.result.current.workPartyPrefillName).toBe("Spring"),
    );
    expect(selectDates).not.toHaveBeenCalled();
    hook.rerender({ ...props, scopedLodgeId: "lodge-1", onDatesStep: true });
    await waitFor(() => expect(selectDates).toHaveBeenCalledTimes(1));
  });

  it("fills nothing in while bookings are blocked by an unpaid subscription", async () => {
    fetchMock.mockResolvedValue(workPartyResponse({ lodgeId: null }));
    const { hook, props, selectDates } = setup({
      scopedLodgeId: "lodge-1",
      bookingBlocked: null,
    });
    await waitFor(() =>
      expect(hook.result.current.workPartyPrefillName).toBe("Spring"),
    );
    expect(selectDates).not.toHaveBeenCalled();
    hook.rerender({ ...props, scopedLodgeId: "lodge-1", bookingBlocked: true });
    hook.rerender({ ...props, scopedLodgeId: "lodge-1", bookingBlocked: false });
    expect(selectDates).not.toHaveBeenCalled();
    expect(
      hook.result.current.takePendingWorkPartySelection([{ id: "wp-1" }]),
    ).toBeNull();
  });

  it("keeps the member's own dates when they picked before the work party arrived", async () => {
    let resolve: (value: unknown) => void = () => {};
    fetchMock.mockReturnValue(new Promise((r) => (resolve = r)));
    const { hook, props, selectLodge, selectDates } = setup({
      scopedLodgeId: "lodge-1",
      lodgeId: "lodge-1",
      memberStarted: true,
    });
    await act(async () => resolve(workPartyResponse()));
    await waitFor(() =>
      expect(hook.result.current.workPartyPrefillName).toBe("Spring"),
    );
    hook.rerender({ ...props, scopedLodgeId: "lodge-1", lodgeId: "lodge-1" });
    expect(selectLodge).not.toHaveBeenCalled();
    expect(selectDates).not.toHaveBeenCalled();
  });

  it("decides nothing while the lodge list has failed, and goes on once it loads", async () => {
    fetchMock.mockResolvedValue(workPartyResponse());
    const { hook, props, selectLodge } = setup({ lodgesSettled: false, lodgeIds: [] });
    await waitFor(() =>
      expect(hook.result.current.workPartyPrefillName).toBe("Spring"),
    );
    expect(hook.result.current.workPartyPrefillNotice).toBeNull();
    expect(selectLodge).not.toHaveBeenCalled();
    hook.rerender({ ...props, lodgesSettled: true, lodgeIds: ["lodge-2"] });
    await waitFor(() => expect(selectLodge).toHaveBeenCalledWith("lodge-2"));
  });
});
