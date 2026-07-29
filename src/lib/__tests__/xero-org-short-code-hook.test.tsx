// @vitest-environment jsdom

import { useEffect } from "react";
import { render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useXeroOrgShortCode,
  type XeroOrgShortCodeState,
} from "@/hooks/use-xero-org-short-code";

// #2261: the short code is read from /api/admin/xero/organisation (which caches
// the underlying Xero getOrganisations call in-process for 12 hours), never
// from /api/admin/xero/status. These pins hold the two properties that keep it
// off the hot path: no request at all while disconnected, and a failed read
// degrades to null (generic link) instead of throwing or retrying — plus the
// loading flag that stops a still-in-flight read being reported as a failed one.
describe("useXeroOrgShortCode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not call the organisation route while Xero is disconnected", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useXeroOrgShortCode(false));

    expect(result.current).toEqual({ shortCode: null, loading: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the short code once connected", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        name: "Alpine Club",
        financialYearEndMonth: 3,
        shortCode: "!aBc12",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useXeroOrgShortCode(true));

    await waitFor(() =>
      expect(result.current).toEqual({ shortCode: "!aBc12", loading: false }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/xero/organisation", {
      credentials: "same-origin",
    });
  });

  // The first paint on a connected page must say "loading", not "unavailable":
  // an uncached organisation read is a live Xero call, so the window is real.
  it("reports loading on the very first render when already connected", () => {
    let resolveFetch: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = () =>
              resolve({ ok: true, json: async () => ({ shortCode: "!aBc12" }) });
          }),
      ),
    );

    const { result } = renderHook(() => useXeroOrgShortCode(true));

    expect(result.current).toEqual({ shortCode: null, loading: true });
    resolveFetch?.();
  });

  // The page mounts before its connection status has loaded, so `connected`
  // flips false -> true one render later. If the hook only started loading in
  // its effect, that render would COMMIT `{shortCode: null, loading: false}` —
  // one painted frame in which the button blames a failed read for a read that
  // had not started. Every committed state is recorded here, so an intermediate
  // commit cannot hide behind a later correct one.
  it("never commits a settled-but-empty state when the connection arrives", async () => {
    let resolveFetch: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = () =>
              resolve({ ok: true, json: async () => ({ shortCode: "!aBc12" }) });
          }),
      ),
    );

    const committed: Array<XeroOrgShortCodeState & { connected: boolean }> = [];
    function Probe({ connected }: { connected: boolean }) {
      const state = useXeroOrgShortCode(connected);
      // No dependency array: fires after every commit, and never for a render
      // React discards.
      useEffect(() => {
        committed.push({ ...state, connected });
      });
      return null;
    }

    const { rerender } = render(<Probe connected={false} />);
    expect(committed).toEqual([{ shortCode: null, loading: false, connected: false }]);

    rerender(<Probe connected />);

    expect(committed.filter((state) => state.connected && !state.loading)).toEqual(
      [],
    );
    expect(committed.at(-1)).toEqual({
      shortCode: null,
      loading: true,
      connected: true,
    });
    resolveFetch?.();
  });

  it("stays null when the organisation route reports no short code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ name: null, financialYearEndMonth: null, shortCode: null }),
      })),
    );

    const { result } = renderHook(() => useXeroOrgShortCode(true));

    await waitFor(() =>
      expect(result.current).toEqual({ shortCode: null, loading: false }),
    );
  });

  it("swallows a failed read so the caller still renders a generic Xero link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const { result } = renderHook(() => useXeroOrgShortCode(true));

    // Settled, not loading: only now may the caller say the read failed.
    await waitFor(() =>
      expect(result.current).toEqual({ shortCode: null, loading: false }),
    );
  });

  it("settles out of loading when the route returns an error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );

    const { result } = renderHook(() => useXeroOrgShortCode(true));

    await waitFor(() =>
      expect(result.current).toEqual({ shortCode: null, loading: false }),
    );
  });
});
