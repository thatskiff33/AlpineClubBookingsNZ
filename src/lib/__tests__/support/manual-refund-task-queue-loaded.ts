import { screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";

/**
 * Waits until `ManualRefundTaskQueue` has finished its first load, so the rows
 * (or their absence) are in the DOM when the test reads them.
 *
 * ## Why not wait for `data-testid="manual-refund-task-queue"`
 *
 * That card renders while the load is still in flight (`tasks === null`) as
 * well as after it, so `waitFor` on it passes on its first synchronous check
 * and waits for nothing. The rows then appear only if the fetch, the state
 * update and React's commit all land inside the one `setTimeout(0)` that React
 * Testing Library's `asyncWrapper` drains before returning — the same one-turn
 * margin `docs/TESTING.md` describes under "Why not by hand". A loaded runner
 * loses it: #5357 (run 44882262132, "Refund to card" not found) and PR #5430
 * (run 45014191559, "Close this item" not found) both failed with the card
 * holding only "Loading…".
 *
 * The first assertion is synchronous on purpose: call this straight after
 * `render`, while the load is pending. If the loading copy ever changes, it
 * fails loudly instead of letting the wait below pass without waiting.
 */
export async function waitForManualRefundQueueLoaded(): Promise<void> {
  // getByText throws when the text is absent.
  screen.getByText("Loading…");
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
}
