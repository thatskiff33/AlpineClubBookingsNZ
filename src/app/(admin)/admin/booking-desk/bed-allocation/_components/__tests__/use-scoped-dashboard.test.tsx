// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useScopedDashboard } from "../use-scoped-dashboard";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe("useScopedDashboard", () => {
  it("fails closed on A -> B and ignores A when it completes last", async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const load = vi.fn((_signal: AbortSignal, scope: string) =>
      scope === "A" ? a.promise : b.promise,
    );
    const { result, rerender } = renderHook(
      ({ scope }) =>
        useScopedDashboard({
          scopeKey: scope,
          load: (signal) => load(signal, scope),
        }),
      { initialProps: { scope: "A" } },
    );

    rerender({ scope: "B" });
    expect(result.current.value).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => b.resolve("dashboard-B"));
    await waitFor(() => expect(result.current.value).toBe("dashboard-B"));

    await act(async () => a.resolve("dashboard-A"));
    expect(result.current.value).toBe("dashboard-B");
    expect(result.current.error).toBe("");
  });

  it("keeps actions fail-closed after failure and retries the current scope", async () => {
    const load = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce("fresh-dashboard");
    const { result } = renderHook(() =>
      useScopedDashboard({ scopeKey: "A", load }),
    );

    await waitFor(() =>
      expect(result.current.error).toBe("network unavailable"),
    );
    expect(result.current.value).toBeNull();
    expect(result.current.loading).toBe(false);

    let refreshed = false;
    await act(async () => {
      refreshed = await result.current.reload();
    });
    expect(refreshed).toBe(true);
    expect(result.current.error).toBe("");
    expect(result.current.value).toBe("fresh-dashboard");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("fails closed and reports a failed refresh to its caller", async () => {
    const refresh = deferred<string>();
    const load = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockResolvedValueOnce("current-dashboard")
      .mockImplementationOnce(() => refresh.promise);
    const { result } = renderHook(() =>
      useScopedDashboard({ scopeKey: "A", load }),
    );
    await waitFor(() => expect(result.current.value).toBe("current-dashboard"));

    let refreshResult: boolean | undefined;
    act(() => {
      void result.current.reload().then((value) => {
        refreshResult = value;
      });
    });
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.value).toBeNull();

    await act(async () => refresh.reject(new Error("refresh unavailable")));
    await waitFor(() => expect(refreshResult).toBe(false));
    expect(result.current.value).toBeNull();
    expect(result.current.error).toBe("refresh unavailable");
  });

  it("ignores an A-bound optimistic rollback after B has loaded", async () => {
    const load = vi.fn(async (_signal: AbortSignal, scope: string) =>
      Promise.resolve(`dashboard-${scope}`),
    );
    const { result, rerender } = renderHook(
      ({ scope }) =>
        useScopedDashboard({
          scopeKey: scope,
          load: (signal) => load(signal, scope),
        }),
      { initialProps: { scope: "A" } },
    );
    await waitFor(() => expect(result.current.value).toBe("dashboard-A"));
    const rollbackA = result.current.setValue;

    rerender({ scope: "B" });
    await waitFor(() => expect(result.current.value).toBe("dashboard-B"));
    act(() => rollbackA("optimistic-A-rollback"));

    expect(result.current.value).toBe("dashboard-B");
  });

  it("does not call onLoaded for a completion after unmount", async () => {
    const pending = deferred<string>();
    const onLoaded = vi.fn();
    const { unmount } = renderHook(() =>
      useScopedDashboard({
        scopeKey: "A",
        load: () => pending.promise,
        onLoaded,
      }),
    );

    unmount();
    await act(async () => pending.resolve("late-dashboard"));
    expect(onLoaded).not.toHaveBeenCalled();
  });
});
