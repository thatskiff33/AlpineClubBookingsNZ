// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockConfirm = vi.fn(async () => true);
vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({
    confirm: mockConfirm,
    prompt: vi.fn(),
    confirmDialog: null,
  }),
}));

import { useRestoreBuiltInBoards } from "@/app/(admin)/admin/lodge-ops/display/templates/restore-built-ins";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";

/**
 * #2668 review. The built-in restore was the one converted surface with NO
 * behavioural suite: its copy was held up by the tree-walking source contract
 * alone, and that walk is a source scan with known blind spots. A regression
 * that moved the sentence out of the branch — or reintroduced the old claim
 * through a value the scan cannot follow — would have shipped.
 *
 * It is also the surface whose message makes an extra promise: "Restoring again
 * is safe." That promise is the server's (`ensureBuiltInDisplays` upserts each
 * reserved key back to its shipped definition, pinned by
 * `lodge-display-built-in-seeds` and `admin-display-built-ins-restore`), and
 * what the CLIENT owes it is that a retry is actually possible and is the same
 * request — not a second, different write.
 */

function Host({ onResult }: { onResult: (message: string, restored: boolean) => void }) {
  const { run, running } = useRestoreBuiltInBoards({ onResult });
  return (
    <button type="button" onClick={() => void run()}>
      {running ? "Restoring…" : "Restore built-in boards"}
    </button>
  );
}

function press() {
  fireEvent.click(screen.getByRole("button", { name: /Restore built-in boards/ }));
}

beforeEach(() => {
  mockConfirm.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Restore built-in boards — an outcome the browser never read (#2668)", () => {
  it("claims no outcome when the POST's answer is never read", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const onResult = vi.fn();

    render(<Host onResult={onResult} />);
    press();

    await waitFor(() => expect(onResult).toHaveBeenCalled());
    const [message, restored] = onResult.mock.calls.at(-1) as [string, boolean];
    expect(message).toBe(
      unverifiedWriteMessage(
        "the built-in boards were restored",
        "Reload the page to see their current state. Restoring again is safe.",
      ),
    );
    // The claim this surface used to make. `fetch` rejects after a committed
    // POST as readily as before an uncommitted one.
    expect(message).not.toContain("Nothing was changed");
    expect(message).not.toMatch(/nothing was/i);
    // And nothing is reported as restored, so the caller's success handling
    // (the gallery reload) does not run on a guess.
    expect(restored).toBe(false);
  });

  it("lets the same restore be pressed again, unchanged", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ layouts: 7, templates: 7 }),
      } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const onResult = vi.fn();

    render(<Host onResult={onResult} />);
    press();
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));

    // The re-entrancy guard released, so "Restoring again is safe" is an
    // instruction the operator can actually follow…
    press();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // …and the retry is the SAME request: no force flag, no second endpoint,
    // nothing that would make the second press mean something different from
    // the first if the first one had in fact landed.
    expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/admin/display/built-ins/restore",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toEqual({ method: "POST" });

    const [message, restored] = onResult.mock.calls.at(-1) as [string, boolean];
    expect(message).toContain("Restored the built-in boards");
    expect(restored).toBe(true);
  });

  it("keeps the confident wording for a refusal the server reported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: "The built-in boards are locked." }),
      })),
    );
    const onResult = vi.fn();

    render(<Host onResult={onResult} />);
    press();

    await waitFor(() => expect(onResult).toHaveBeenCalled());
    // The server answered, so its own words stand — this is the contrast that
    // keeps the unverified copy from swallowing every failure.
    expect(onResult.mock.calls.at(-1)?.[0]).toBe(
      "The built-in boards are locked.",
    );
  });

  it("writes nothing at all when the confirmation is declined", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockConfirm.mockResolvedValue(false);
    const onResult = vi.fn();

    render(<Host onResult={onResult} />);
    press();

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });
});
