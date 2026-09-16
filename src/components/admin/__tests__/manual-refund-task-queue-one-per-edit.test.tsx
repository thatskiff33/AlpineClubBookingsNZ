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

/**
 * #3498 — ONE card per parked change, and a way back from a wrong click.
 *
 * Owner decision D1 moved the work item from the guest strand to the EDIT, and
 * what this file is about is the part an officer sees: that the supporting
 * strands really are on the card rather than quietly dropped, that they are
 * shown without a name or an identifier the payload does not carry, that the
 * settle dialog asks for each repairable strand's nights separately, and that a
 * dismissal can be put back.
 *
 * MUTATION PROOF. Drop `otherStrands` from the evidence block and "carries every
 * other guest the change touched" fails. Key the night boxes by date alone and
 * "keeps two guests' boxes apart when they hold the same nights" fails — two
 * guests of one booking routinely hold the same lodge nights, which is exactly
 * when a date-keyed box takes the wrong guest's typing. Post the officer's
 * figures as one flat array and "posts one array per strand, in the item's own
 * order" fails. Offer a reopen control for a COMPLETED row and "offers nothing
 * for a row the officer settled" fails — and that one is not cosmetic, because
 * the money on such a row has already moved.
 */

const STAY = {
  checkIn: "2026-08-10T00:00:00Z",
  checkOut: "2026-08-12T00:00:00Z",
};

const LEAD_STRAND = {
  cause: "COUNTERPART_STRAND_UNREADABLE",
  surrenderedNightDates: ["2026-08-10", "2026-08-11"],
  addedNightDates: [],
  storedEvidence: {
    guestTotalCents: 12000,
    nightPrices: [
      { date: "2026-08-10", priceCents: 6000 },
      { date: "2026-08-11", priceCents: 6000 },
    ],
  },
};

/** A guest nobody touched, whose rows the change rewrites anyway. */
const UNTOUCHED_STRAND = {
  cause: "INEXACT_STORED_NIGHT_PRICES",
  surrenderedNightDates: [],
  addedNightDates: [],
  storedEvidence: {
    guestTotalCents: 14000,
    nightPrices: [
      { date: "2026-08-10", priceCents: 7000 },
      { date: "2026-08-11", priceCents: 7000 },
    ],
  },
};

const ONE_ITEM_PER_EDIT = {
  id: "task-review",
  bookingId: "booking-edit",
  amountCents: null,
  raisedAmountCents: null,
  kind: "EDIT_FINANCIAL_REVIEW",
  reason: "A change to this booking could not be priced from stored history.",
  createdAt: "2026-06-21T00:00:00Z",
  memberName: "Grace Hopper",
  reviewEvidence: {
    ...LEAD_STRAND,
    otherStrands: [UNTOUCHED_STRAND, UNTOUCHED_STRAND],
    bookingCheckIn: "2026-08-10",
    bookingCheckOut: "2026-08-12",
    guestsAddedByEdit: null,
  },
  reviewEvidenceUnreadable: false,
  ...STAY,
};

/** Two strands of one booking, both holding the SAME two lodge nights. */
const TWO_REPAIRABLE_STRANDS = {
  ...ONE_ITEM_PER_EDIT,
  unpricedNights: [
    {
      dates: ["2026-08-10", "2026-08-11"],
      knownNightTotalCents: 0,
      storedGuestTotalCents: 12000,
    },
    {
      dates: ["2026-08-10", "2026-08-11"],
      knownNightTotalCents: 0,
      storedGuestTotalCents: 14000,
    },
  ],
};

const DISMISSED_ROW = {
  id: "task-dismissed",
  bookingId: "booking-edit",
  amountCents: null,
  kind: "EDIT_FINANCIAL_REVIEW",
  reason: "A change to this booking could not be priced from stored history.",
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
  await waitFor(() =>
    expect(screen.getByTestId("manual-refund-task-queue")).toBeInTheDocument(),
  );
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

describe("one card per parked change (#3498 D1)", () => {
  it("carries every other guest the change touched, as supporting detail", async () => {
    await renderQueue({
      tasks: [ONE_ITEM_PER_EDIT],
      viewerCanViewBookings: true,
    });

    const supporting = screen.getByTestId(
      "manual-refund-task-review-other-strands",
    );
    // The line that says there is ONE thing to record, not one per guest - which
    // is the whole of what changed for the officer.
    expect(supporting).toHaveTextContent(
      /also touched 2 other guests on this booking/i,
    );
    expect(supporting).toHaveTextContent(/one adjustment to record/i);
    // And each of their stored figures really is there, rather than summarised
    // away: these are the numbers the change is about to destroy.
    expect(supporting).toHaveTextContent(/\$140\.00/);
    expect(supporting).toHaveTextContent(/\$70\.00/);
  });

  it("names no guest and prints no identifier for them", async () => {
    // The payload has no field for a guest-strand id or a member id, so the card
    // could not print one - and a list of strands must not become the place that
    // reintroduces them. Numbered instead.
    await renderQueue({
      tasks: [ONE_ITEM_PER_EDIT],
      viewerCanViewBookings: true,
    });
    const supporting = screen.getByTestId(
      "manual-refund-task-review-other-strands",
    );
    expect(supporting).toHaveTextContent("Guest 2 of 3");
    expect(supporting).toHaveTextContent("Guest 3 of 3");
  });

  it("renders as it always did for a row raised before the change", async () => {
    // Production is holding rows with no `otherStrands` at all, and they are
    // worked by hand. An absent list is the one-strand item it describes, not a
    // reason for the evidence block to disappear.
    const legacy = {
      ...ONE_ITEM_PER_EDIT,
      reviewEvidence: {
        ...LEAD_STRAND,
        bookingCheckIn: "2026-08-10",
        bookingCheckOut: "2026-08-12",
        guestsAddedByEdit: null,
      },
    };
    await renderQueue({ tasks: [legacy], viewerCanViewBookings: true });

    expect(
      screen.getByTestId("manual-refund-task-review-evidence"),
    ).toHaveTextContent(/Nights given back/i);
    expect(
      screen.queryByTestId("manual-refund-task-review-other-strands"),
    ).not.toBeInTheDocument();
  });
});

describe("the settle dialog asks each strand separately (#3498 D1)", () => {
  async function openNoAdjustment(task: unknown) {
    const fetchMock = await renderQueue({
      tasks: [task],
      viewerCanViewBookings: true,
    });
    fireEvent.click(screen.getByRole("button", { name: /No adjustment/i }));
    await waitFor(() =>
      expect(
        screen.getAllByTestId("unpriced-night-price-fields").length,
      ).toBeGreaterThan(0),
    );
    return fetchMock;
  }

  it("keeps two guests' boxes apart when they hold the same nights", async () => {
    await openNoAdjustment(TWO_REPAIRABLE_STRANDS);

    const fieldsets = screen.getAllByTestId("unpriced-night-price-fields");
    expect(fieldsets).toHaveLength(2);

    // The failure this pins is not cosmetic. Keyed by date alone, both guests'
    // 10 Aug boxes carried the same `id`, so clicking one guest's label focused
    // the other's box and typing landed in whichever the browser found first.
    const first = within(fieldsets[0]!).getAllByRole("textbox")[0]!;
    const second = within(fieldsets[1]!).getAllByRole("textbox")[0]!;
    expect(first.id).not.toBe(second.id);

    fireEvent.change(first, { target: { value: "60.00" } });
    expect((second as HTMLInputElement).value).toBe("");
  });

  it("posts one array per strand, in the item's own order", async () => {
    const fetchMock = await openNoAdjustment(TWO_REPAIRABLE_STRANDS);
    const fieldsets = screen.getAllByTestId("unpriced-night-price-fields");

    // A dismissal moves nothing, so each strand's figures must come to its own
    // stored total exactly: $120.00 for the first guest, $140.00 for the second.
    const [firstA, firstB] = within(fieldsets[0]!).getAllByRole("textbox");
    fireEvent.change(firstA!, { target: { value: "60.00" } });
    fireEvent.change(firstB!, { target: { value: "60.00" } });
    const [secondA, secondB] = within(fieldsets[1]!).getAllByRole("textbox");
    fireEvent.change(secondA!, { target: { value: "70.00" } });
    fireEvent.change(secondB!, { target: { value: "70.00" } });

    fireEvent.change(screen.getByLabelText(/Note/i), {
      target: { value: "Nothing owed either way; recorded what they sold for." },
    });

    const confirm = screen.getByRole("button", {
      name: /Close with no adjustment/i,
    });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    expect(lastPost(fetchMock).body.recordedNightPrices).toEqual([
      [
        { date: "2026-08-10", priceCents: 6000 },
        { date: "2026-08-11", priceCents: 6000 },
      ],
      [
        { date: "2026-08-10", priceCents: 7000 },
        { date: "2026-08-11", priceCents: 7000 },
      ],
    ]);
  });

  it("will not close while ANY strand's figures are short", async () => {
    // #3219 D2 applies per strand now: the server checks every one of them and
    // the screen posts all or nothing, so one complete column is not an answer.
    await openNoAdjustment(TWO_REPAIRABLE_STRANDS);
    const fieldsets = screen.getAllByTestId("unpriced-night-price-fields");
    const [firstA, firstB] = within(fieldsets[0]!).getAllByRole("textbox");
    fireEvent.change(firstA!, { target: { value: "60.00" } });
    fireEvent.change(firstB!, { target: { value: "60.00" } });
    fireEvent.change(screen.getByLabelText(/Note/i), {
      target: { value: "Nothing owed either way." },
    });

    expect(
      screen.getByRole("button", { name: /Close with no adjustment/i }),
    ).toBeDisabled();
  });
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
