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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const access = vi.hoisted(() => ({ canEdit: true as boolean | undefined }));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/use-admin-area-edit-access")
  >()),
  useAdminAreaEditAccess: () => access.canEdit,
}));

import { BookingStoredNightPriceControls } from "@/components/admin/booking-stored-night-price-controls";
import { requireCalendarDate } from "@/lib/club-time";
import {
  STORED_NIGHT_PRICE_RECORD_CONTROL_LABEL,
  type StrandNightPriceOffer,
} from "@/lib/stored-night-price-repair";

/**
 * #3214 (epic #2797) - the officer's control for recording what a guest's
 * nights sold for.
 *
 * ## THE HALF THE SOURCE CENSUS CANNOT SEE
 *
 * `stored-night-price-repair-census.test.ts` scans this file for a division, a
 * rounding, a `split*` helper, an averaging pass and a defaulted zero. A
 * REMAINDER FILL matches none of them - `targetCents - enteredCents` is a
 * subtraction - and the server cannot catch it either, because it would arrive
 * as a complete, reconciling vector `checkStoredNightPriceRepair` is obliged to
 * accept. The property is about the RESULT, so it is asserted here as behaviour
 * on the real component, exactly as
 * `manual-refund-task-queue-financial-review.test.tsx` does for the settle
 * screen.
 *
 * The instrument is the same one that lens hardened: the control INVENTORY is
 * pinned, and every control that is not the confirm is pressed, whatever it is
 * called - so a "Use the balance" button fails here however it is spelled. Its
 * second half covers a fill that never touches a box, by refusing to let the
 * screen post a set it completed for the officer.
 *
 * MUTATION PROOF: both shapes were built and both fail here.
 */

const on = (date: string) => requireCalendarDate(date);

const NO_ROWS: StrandNightPriceOffer = {
  bookingGuestId: "guest-1",
  guestName: "Vic Visitor",
  cause: "NO_STORED_NIGHT_PRICES",
  summary: {
    dates: [on("2026-08-01"), on("2026-08-02")],
    knownNightTotalCents: 0,
    storedGuestTotalCents: 10_000,
  },
  storedByDate: [
    { date: on("2026-08-01"), priceCents: null },
    { date: on("2026-08-02"), priceCents: null },
  ],
};

const MISMATCH: StrandNightPriceOffer = {
  ...NO_ROWS,
  bookingGuestId: "guest-2",
  guestName: "Mo Mismatch",
  cause: "STORED_TOTAL_MISMATCH",
  storedByDate: [
    { date: on("2026-08-01"), priceCents: 0 },
    { date: on("2026-08-02"), priceCents: 4_000 },
  ],
};

const nightBox = (date: string) =>
  screen.getByLabelText(
    (_content, element) => element?.id === `unpriced-night-${date}`,
  );

type FetchCall = [string, { body: string }];

function stubFetch(status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => ({ message: "Done." }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const fetchCalls = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls as unknown as FetchCall[];

const postBodies = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchCalls(fetchMock).map(
    ([, init]) => JSON.parse(init.body) as Record<string, unknown>,
  );

beforeEach(() => {
  access.canEdit = true;
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the section only appears when the server offered something", () => {
  it("renders nothing at all with no offers", () => {
    const { container } = render(
      <BookingStoredNightPriceControls bookingId="booking-1" offers={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one form per unreadable strand, named", () => {
    render(
      <BookingStoredNightPriceControls
        bookingId="booking-1"
        offers={[NO_ROWS, MISMATCH]}
      />,
    );
    expect(screen.getAllByTestId("stored-night-price-strand")).toHaveLength(2);
    expect(screen.getByText("Vic Visitor")).toBeInTheDocument();
    expect(screen.getByText("Mo Mismatch")).toBeInTheDocument();
  });

  it("keeps an absent stored price apart from a comped night", () => {
    // $0.00 is a real sold price and an absence is not a price at all. Rendering
    // the two the same way is the collapse this whole epic exists to remove.
    render(
      <BookingStoredNightPriceControls
        bookingId="booking-1"
        offers={[MISMATCH]}
      />,
    );
    const strand = screen.getByTestId("stored-night-price-strand");
    expect(strand).toHaveTextContent("$0.00");
    expect(strand).toHaveTextContent("$40.00");
    expect(strand).not.toHaveTextContent("no stored price");
  });
});

describe("nothing on this screen produces an amount", () => {
  it("arrives with every box empty and the control disarmed", () => {
    render(
      <BookingStoredNightPriceControls
        bookingId="booking-1"
        offers={[NO_ROWS]}
      />,
    );
    expect(nightBox("2026-08-01")).toHaveValue("");
    expect(nightBox("2026-08-02")).toHaveValue("");
    expect(
      screen.getByRole("button", { name: STORED_NIGHT_PRICE_RECORD_CONTROL_LABEL }),
    ).toBeDisabled();
  });

  it("no control fills a box in, and nothing it posts carries a night nobody typed", () => {
    const fetchMock = stubFetch();
    render(
      <BookingStoredNightPriceControls
        bookingId="booking-1"
        offers={[NO_ROWS]}
      />,
    );
    // One night left and one figure outstanding - exactly when a screen is
    // tempted to be helpful.
    fireEvent.change(nightBox("2026-08-01"), { target: { value: "35.00" } });

    const strand = screen.getByTestId("stored-night-price-strand");
    const buttonName = (button: HTMLElement) =>
      (button.textContent ?? "").trim();
    /*
      The inventory, pinned. A new control fails HERE and has to be added below
      - at which point the loop underneath presses it and proves it does not
      fill a box in. Without this the loop would be a guard that only arms
      itself once somebody has already added the thing it guards against.

      OVER THE WHOLE SCREEN, not `within(strand)`. A "fill the rest" control put
      on the outer SECTION rather than inside a strand would be neither
      inventoried nor pressed, and a remainder fill is the one shape the source
      census provably cannot see - so the scope that matters is every button
      this component renders, wherever it hangs.
    */
    expect(new Set(screen.getAllByRole("button").map(buttonName))).toEqual(
      new Set([STORED_NIGHT_PRICE_RECORD_CONTROL_LABEL]),
    );

    const confirm = within(strand).getByRole("button", {
      name: STORED_NIGHT_PRICE_RECORD_CONTROL_LABEL,
    });
    for (const button of screen.getAllByRole("button")) {
      if (button === confirm) continue;
      fireEvent.click(button);
    }

    expect(nightBox("2026-08-01")).toHaveValue("35.00");
    expect(nightBox("2026-08-02")).toHaveValue("");

    // And it will not post a set it completed for them either - the only thing
    // that catches a fill made straight into the posted entries, where there is
    // no box value to look at.
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a set that does not come to what the stay is stored as worth", () => {
    const fetchMock = stubFetch();
    render(
      <BookingStoredNightPriceControls
        bookingId="booking-1"
        offers={[NO_ROWS]}
      />,
    );
    fireEvent.change(nightBox("2026-08-01"), { target: { value: "35.00" } });
    fireEvent.change(nightBox("2026-08-02"), { target: { value: "35.00" } });

    // Both figures and the target, always - showing only the shortfall would
    // hand the officer the second night's price.
    const status = screen.getByTestId("unpriced-night-price-reconciliation");
    expect(status).toHaveTextContent("$70.00");
    expect(status).toHaveTextContent("$100.00");
    fireEvent.click(
      screen.getByRole("button", { name: STORED_NIGHT_PRICE_RECORD_CONTROL_LABEL }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("what a complete answer posts", () => {
  it("sends every night, the strand it belongs to, and an explicit confirmation", async () => {
    const fetchMock = stubFetch();
    render(
      <BookingStoredNightPriceControls
        bookingId="booking-1"
        offers={[NO_ROWS]}
      />,
    );
    fireEvent.change(nightBox("2026-08-01"), { target: { value: "45.00" } });
    fireEvent.change(nightBox("2026-08-02"), { target: { value: "55.00" } });
    fireEvent.change(screen.getByLabelText("Note (optional)"), {
      target: { value: "From the quote." },
    });

    fireEvent.click(
      screen.getByRole("button", { name: STORED_NIGHT_PRICE_RECORD_CONTROL_LABEL }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(fetchCalls(fetchMock)[0][0]).toBe(
      "/api/admin/bookings/booking-1/stored-night-prices",
    );
    expect(postBodies(fetchMock)[0]).toEqual({
      bookingGuestId: "guest-1",
      confirmed: true,
      note: "From the quote.",
      nightPrices: [
        { date: "2026-08-01", priceCents: 4_500 },
        { date: "2026-08-02", priceCents: 5_500 },
      ],
    });
  });

  it("takes a typed 0.00 as a real price, not as an empty box", async () => {
    const fetchMock = stubFetch();
    render(
      <BookingStoredNightPriceControls
        bookingId="booking-1"
        offers={[NO_ROWS]}
      />,
    );
    fireEvent.change(nightBox("2026-08-01"), { target: { value: "0.00" } });
    fireEvent.change(nightBox("2026-08-02"), { target: { value: "100.00" } });

    fireEvent.click(
      screen.getByRole("button", { name: STORED_NIGHT_PRICE_RECORD_CONTROL_LABEL }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(postBodies(fetchMock)[0].nightPrices).toEqual([
      { date: "2026-08-01", priceCents: 0 },
      { date: "2026-08-02", priceCents: 10_000 },
    ]);
  });

  it("names a box holding something that is not an amount, and posts nothing", () => {
    const fetchMock = stubFetch();
    render(
      <BookingStoredNightPriceControls
        bookingId="booking-1"
        offers={[NO_ROWS]}
      />,
    );
    fireEvent.change(nightBox("2026-08-01"), { target: { value: "$45" } });
    fireEvent.change(nightBox("2026-08-02"), { target: { value: "55.00" } });

    // "give an amount for every night" over a column of visibly-filled boxes is
    // the #2685 class; the refusal names the night instead.
    expect(
      screen.getByTestId("unpriced-night-price-reconciliation"),
    ).toHaveTextContent("is not one this box can read");
    fireEvent.click(
      screen.getByRole("button", { name: STORED_NIGHT_PRICE_RECORD_CONTROL_LABEL }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a view-only finance admin", () => {
  it("gets the section banner, every control dead, and posts nothing", () => {
    access.canEdit = false;
    const fetchMock = stubFetch();
    render(
      <BookingStoredNightPriceControls
        bookingId="booking-1"
        offers={[NO_ROWS]}
      />,
    );

    expect(screen.getByTestId("admin-view-only-banner")).toHaveTextContent(
      /view/i,
    );
    expect(nightBox("2026-08-01")).toBeDisabled();
    expect(screen.getByLabelText("Note (optional)")).toBeDisabled();
    const confirm = screen.getByRole("button", {
      name: STORED_NIGHT_PRICE_RECORD_CONTROL_LABEL,
    });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
