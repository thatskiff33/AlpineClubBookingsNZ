// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

import { ManualRefundTaskQueue } from "@/components/admin/manual-refund-task-queue";
import { waitForManualRefundQueueLoaded } from "@/lib/__tests__/support/manual-refund-task-queue-loaded";

/**
 * #3498 (owner decision D2) — a way back from a wrong click: a money task an
 * officer dismissed can be put back on the queue.
 *
 * The rest of this file was the officer edit review's one-card-per-change
 * settle dialog, retired with the review in #4344 (wave C1 of #4302). The
 * reopen card itself never offers a review: the route leaves the kind out of
 * the dismissed list (`manual-refund-task-queue-reads.test.ts`).
 *
 * MUTATION PROOF. Offer a reopen control with no rows listed and "offers
 * nothing for a row the officer settled" fails - and that one is not cosmetic,
 * because the money on a completed row has already moved.
 */

const STAY = {
  checkIn: "2026-08-10T00:00:00Z",
  checkOut: "2026-08-12T00:00:00Z",
};

const DISMISSED_ROW = {
  id: "task-dismissed",
  bookingId: "booking-edit",
  amountCents: 4500,
  kind: "CANCELLED_BOOKING_HAND_BACK",
  reason: "Cancelled after a cash payment.",
  note: "Nothing owed either way.",
  dismissedAt: "2026-06-25T02:00:00.000Z",
  bookingDeleted: false,
  memberName: "Ada Lovelace",
  ...STAY,
};

function stubLoad(body: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderQueue(body: unknown) {
  const fetchMock = stubLoad(body);
  render(<ManualRefundTaskQueue />);
  await waitForManualRefundQueueLoaded();
  return fetchMock;
}

/**
 * The last POST, not the last call. Both screens RELOAD the queue after a
 * successful write, so `calls.at(-1)` is the GET that follows it - and a helper
 * that reads that instead fails with "cannot read 'body' of undefined", which
 * looks like the write never happening.
 */
function lastPost(fetchMock: ReturnType<typeof vi.fn>) {
  const calls = fetchMock.mock.calls as unknown as Array<
    [string, { body?: string } | undefined]
  >;
  const post = [...calls].reverse().find((call) => call[1]?.body !== undefined);
  if (!post) throw new Error("no POST was made");
  return { url: post[0], body: JSON.parse(post[1]!.body!) as Record<string, unknown> };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("putting a dismissal back on the queue (#3498 D2)", () => {
  it("lists what was closed with no adjustment, and offers one action", async () => {
    await renderQueue({
      tasks: [],
      dismissed: [DISMISSED_ROW],
      viewerCanViewBookings: true,
    });

    const card = screen.getByTestId("dismissed-manual-refund-tasks");
    expect(card).toHaveTextContent("Ada Lovelace");
    // The note the closing officer wrote is what an officer needs to decide
    // whether the closure was wrong, so it is on the row rather than behind it.
    expect(card).toHaveTextContent("Nothing owed either way.");
    expect(
      within(card).getByRole("button", { name: /Put back on the queue/i }),
    ).toBeEnabled();
  });

  it("says the window and the cap it is showing, as a fact about the LIST", async () => {
    /*
      #3498 fix round (S5). The query is bounded at thirty days and a hundred
      rows and the card said neither, so an officer who dismissed something five
      weeks ago found nothing here and was told nothing about why - while the
      automatic-refund card beside it publishes its own bound.

      It has to read as a fact about what is LISTED, never about what may be
      corrected: `reopenManualRefundTask` refuses on status and on who closed the
      row, and never on age.
    */
    await renderQueue({
      tasks: [],
      dismissed: [DISMISSED_ROW],
      viewerCanViewBookings: true,
    });

    const card = screen.getByTestId("dismissed-manual-refund-tasks");
    expect(card).toHaveTextContent(/last 30 days/i);
    expect(card).toHaveTextContent(/up to 100/i);
    expect(card).toHaveTextContent(/An older one is not off limits/i);
  });

  it("says an unknown amount rather than leaving the row looking empty", async () => {
    /*
      #3498 fix round (S6). `amountCents` is null on EVERY parked-edit closure -
      a parked edit's amount is precisely what nobody could work out - and the
      row rendered the member's name and nothing else, which reads as a row with
      nothing on it. Never a fabricated $0.00 either: zero is a real financial
      statement this system has not made.
    */
    await renderQueue({
      tasks: [],
      dismissed: [{ ...DISMISSED_ROW, amountCents: null }],
      viewerCanViewBookings: true,
    });

    const row = screen.getByTestId("dismissed-manual-refund-task");
    expect(row).toHaveTextContent(/no amount was recorded/i);
    expect(row).not.toHaveTextContent(/\$0\.00/);
  });

  it("offers nothing for a row the officer settled, because that money has moved", async () => {
    // The route lists dismissals only, so a completed row never reaches this
    // card - and the card renders only what it is given. The server refuses one
    // too; this is the courtesy half.
    await renderQueue({ tasks: [], dismissed: [], viewerCanViewBookings: true });
    expect(
      screen.queryByTestId("dismissed-manual-refund-tasks"),
    ).not.toBeInTheDocument();
  });

  it("asks why, and will not post without it", async () => {
    await renderQueue({
      tasks: [],
      dismissed: [DISMISSED_ROW],
      viewerCanViewBookings: true,
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Put back on the queue/i }),
    );

    const dialog = await screen.findByRole("dialog");
    // The note is the only record of why a recorded decision was undone, so the
    // control is dead until there is one.
    const confirm = within(dialog).getByRole("button", {
      name: /Put back on the queue/i,
    });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Note/i), {
      target: { value: "Closed by mistake while working several rows." },
    });
    expect(confirm).toBeEnabled();
  });

  it("says plainly that nothing is paid, charged or credited by it", async () => {
    await renderQueue({
      tasks: [],
      dismissed: [DISMISSED_ROW],
      viewerCanViewBookings: true,
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Put back on the queue/i }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/Nothing is paid, charged or credited/i);
    // And what it DOES set in motion, which an officer has to know before
    // pressing: the booking is fenced again and the member is told again.
    expect(dialog).toHaveTextContent(/held until it is settled/i);
  });

  it("posts the reopen with an explicit confirmation", async () => {
    const fetchMock = await renderQueue({
      tasks: [],
      dismissed: [DISMISSED_ROW],
      viewerCanViewBookings: true,
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Put back on the queue/i }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Note/i), {
      target: { value: "Closed by mistake." },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: /Put back on the queue/i }),
    );

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    const post = lastPost(fetchMock);
    expect(post.url).toContain(
      "/api/admin/payments/manual-refund-tasks/task-dismissed/reopen",
    );
    expect(post.body).toEqual({
      confirmed: true,
      note: "Closed by mistake.",
    });
  });
});
