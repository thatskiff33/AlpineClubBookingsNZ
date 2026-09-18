// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

import { toast } from "sonner";
import {
  BookingManualPaymentControls,
  type BookingManualPaymentState,
} from "@/components/admin/booking-manual-payment-controls";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

function settledState(
  overrides: Partial<BookingManualPaymentState> = {}
): BookingManualPaymentState {
  return {
    amountOwingCents: 0,
    storedCreditElectionCents: null,
    outstandingAdditionalCents: 0,
    canMarkPaid: false,
    markPaidBlockedReason: null,
    manuallyMarkedPaidAt: "2026-07-20T00:00:00Z",
    manuallyMarkedPaidByName: "Ada Lovelace",
    manualPaymentNote: null,
    canReverse: true,
    reverseBlockedReason: null,
    ...overrides,
  };
}

/** An unsettled booking with the mark-paid action offered. */
function payableState(
  overrides: Partial<BookingManualPaymentState> = {}
): BookingManualPaymentState {
  return {
    ...settledState(),
    amountOwingCents: 12000,
    canMarkPaid: true,
    manuallyMarkedPaidAt: null,
    manuallyMarkedPaidByName: null,
    canReverse: false,
    ...overrides,
  };
}

function openMarkPaidDialog(state: BookingManualPaymentState) {
  render(
    <BookingManualPaymentControls
      bookingId="bk_1"
      memberName="Ada Lovelace"
      state={state}
    />
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Record manual payment/i })
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BookingManualPaymentControls — reversal dialog copy (#2262 M5)", () => {
  it("spells out the capacity consequence: restored awaiting-payment stops holding beds, and a later re-record can be refused", () => {
    render(
      <BookingManualPaymentControls
        bookingId="bk_1"
        memberName="Ada Lovelace"
        state={settledState()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Reverse manual payment" })
    );

    // The reversal's own effect…
    expect(
      screen.getByText(/goes back to being unpaid/i)
    ).toBeTruthy();
    // …AND its converse capacity consequence, so the admin is not surprised
    // when the beds are gone by the time the payment is re-recorded.
    expect(
      screen.getByText(/stops holding its beds/i)
    ).toBeTruthy();
    expect(
      screen.getByText(/can be refused if the lodge has filled/i)
    ).toBeTruthy();
  });
});

/**
 * #2262 delta MED-3. Recording cash cannot honour a stored credit election — the
 * money changed hands outside the app — so the settle clears it. That is a
 * legitimate outcome and the settle must NOT be refused (refusing would strand
 * an admin holding the member's cash), but the click is the last preventable
 * moment, so the dialog has to say so BEFORE it, not only in the alert
 * afterwards.
 */
describe("BookingManualPaymentControls — stored credit election warning (#2262 / #2265)", () => {
  it("warns in the mark-paid dialog, naming the amount and saying the credit will go unused", () => {
    openMarkPaidDialog(payableState({ storedCreditElectionCents: 4500 }));

    const warning = screen.getByTestId("manual-payment-credit-election-warning");
    expect(warning.textContent).toContain("$45.00");
    expect(warning.textContent).toMatch(/cannot use it/i);
    expect(warning.textContent).toMatch(/remain available on their account/i);
    // Warned, never blocked: the admin can still record the cash they hold.
    expect(
      screen.getByRole("button", { name: "Record and email member" })
    ).toBeTruthy();
  });

  it("says nothing at all on the overwhelming majority of bookings, which carry no election", () => {
    openMarkPaidDialog(payableState());

    expect(
      screen.queryByTestId("manual-payment-credit-election-warning")
    ).toBeNull();
  });
});

/**
 * #2397. When a booking still carries an uncollected price increase, the person
 * holding the money has to be able to SEE what they are confirming — the extra,
 * and the total it is part of — and say whether the cash covers it. When there
 * is no such extra (nearly always) this common screen must be untouched.
 */
describe("BookingManualPaymentControls — the outstanding-extra question (#2397)", () => {
  function stubFetch() {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ message: "Payment recorded." }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function requestBody(fetchMock: ReturnType<typeof stubFetch>) {
    const call = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    return JSON.parse(call[1].body) as Record<string, unknown>;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the extra, the amount before it, and what is owed in total", () => {
    openMarkPaidDialog(
      payableState({ amountOwingCents: 12100, outstandingAdditionalCents: 2100 })
    );

    const block = screen.getByTestId("manual-payment-additional-coverage");
    expect(block.textContent).toMatch(/not\s+on top of it/i);
    // The split is spelled out rather than left to be inferred from one number.
    expect(
      screen.getByTestId("manual-payment-additional-base").textContent
    ).toBe("$100.00");
    expect(
      screen.getByTestId("manual-payment-additional-extra").textContent
    ).toBe("$21.00");
    expect(
      screen.getByTestId("manual-payment-additional-owing").textContent
    ).toBe("$121.00");
  });

  /**
   * Owner decision, 31 Jul 2026: "no" records only what was handed over. The
   * dialog must therefore never assert one total before the question is
   * answered, and must name the figure each answer will actually record.
   */
  it("names the total each answer records, and asserts none before one is chosen", () => {
    openMarkPaidDialog(
      payableState({ amountOwingCents: 12100, outstandingAdditionalCents: 2100 })
    );

    const total = () =>
      screen.getByTestId("manual-payment-additional-total").textContent;
    expect(total()).toBe("answer below");
    // No figure in the title either, until there is one it can stand behind.
    expect(screen.getByText("Record a payment for Ada Lovelace?")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /^No —/ }));
    expect(total()).toBe("$100.00");
    expect(
      screen.getByText("Record $100.00 as paid for Ada Lovelace?")
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /^Yes —/ }));
    expect(total()).toBe("$121.00");
    expect(
      screen.getByText("Record $121.00 as paid for Ada Lovelace?")
    ).toBeTruthy();
  });

  it("spells out what each answer does, with its figure", () => {
    openMarkPaidDialog(
      payableState({ amountOwingCents: 12100, outstandingAdditionalCents: 2100 })
    );

    const yes = screen.getByRole("radio", { name: /^Yes —/ });
    expect(yes.closest("label")?.textContent).toContain("$121.00");
    expect(yes.closest("label")?.textContent).toMatch(/not be asked for/i);

    const no = screen.getByRole("radio", { name: /^No —/ });
    // The stronger statement: we are recording ONLY the amount before the
    // change, and the addition stays owing.
    expect(no.closest("label")?.textContent).toMatch(
      /record only the \$100\.00 owed before the change/i
    );
    expect(no.closest("label")?.textContent).toMatch(/stays\s+recorded as owing/i);
  });

  it("blocks recording until the question is answered — neither answer is a default", () => {
    openMarkPaidDialog(
      payableState({ amountOwingCents: 12100, outstandingAdditionalCents: 2100 })
    );

    const record = screen.getByRole("button", {
      name: "Record and email member",
    }) as HTMLButtonElement;
    const recordSilently = screen.getByRole("button", {
      name: "Record without emailing",
    }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    expect(recordSilently.disabled).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /^No —/ }));
    expect(record.disabled).toBe(false);
  });

  it("sends the answer, with the figure the admin was shown, when the cash covers it", async () => {
    const fetchMock = stubFetch();
    openMarkPaidDialog(
      payableState({ amountOwingCents: 12100, outstandingAdditionalCents: 2100 })
    );

    fireEvent.click(screen.getByRole("radio", { name: /^Yes —/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record and email member" }));
    await Promise.resolve();

    expect(requestBody(fetchMock)).toMatchObject({
      direction: "paid",
      expectedAmountCents: 12100,
      additionalCoverage: {
        covered: true,
        expectedAdditionalAmountCents: 2100,
      },
    });
  });

  it("sends covered:false when the admin says the cash does not cover it", async () => {
    const fetchMock = stubFetch();
    openMarkPaidDialog(
      payableState({ amountOwingCents: 12100, outstandingAdditionalCents: 2100 })
    );

    fireEvent.click(screen.getByRole("radio", { name: /^No —/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record and email member" }));
    await Promise.resolve();

    expect(requestBody(fetchMock)).toMatchObject({
      additionalCoverage: {
        covered: false,
        expectedAdditionalAmountCents: 2100,
      },
    });
  });

  it("is COMPLETELY unchanged when there is no extra — no question, no field, no block on recording", async () => {
    const fetchMock = stubFetch();
    openMarkPaidDialog(payableState());

    expect(
      screen.queryByTestId("manual-payment-additional-coverage")
    ).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    const record = screen.getByRole("button", {
      name: "Record and email member",
    }) as HTMLButtonElement;
    expect(record.disabled).toBe(false);

    fireEvent.click(record);
    await Promise.resolve();

    expect(requestBody(fetchMock)).not.toHaveProperty("additionalCoverage");
  });
});

/**
 * #2668 — the browser is not entitled to say the ledger did not move.
 *
 * This control used to answer a rejected `fetch` with "Could not reach the
 * server. Nothing was recorded." `fetch` rejects both when the POST never
 * arrived and when it arrived, wrote the manual payment and the booking event,
 * and lost only its answer. Of everywhere in the app that made this guess, this
 * is the one where being wrong costs the most: an admin told nothing happened
 * records the same cash a second time.
 */
describe("BookingManualPaymentControls — an outcome the browser never read (#2668)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(toast.error).mockClear();
  });

  const UNVERIFIED = unverifiedWriteMessage(
    "this payment was recorded",
    "Reload the booking and check before recording it again."
  );

  function openAndFailTheRecording() {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    openMarkPaidDialog({
      amountOwingCents: 12000,
      storedCreditElectionCents: null,
      outstandingAdditionalCents: 0,
      canMarkPaid: true,
      markPaidBlockedReason: null,
      manuallyMarkedPaidAt: null,
      manuallyMarkedPaidByName: null,
      manualPaymentNote: null,
      canReverse: false,
      reverseBlockedReason: null,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Record and email member" })
    );
    return fetchMock;
  }

  it("reports what it could not verify instead of claiming nothing was recorded", async () => {
    openAndFailTheRecording();

    const notice = await screen.findByText(UNVERIFIED);
    expect(notice.textContent).toBe(UNVERIFIED);
    // The specific claim about the ledger the client cannot make, and the
    // instruction that keeps a duplicate cash entry from being the next step.
    expect(notice.textContent).not.toContain("Nothing was recorded");
    expect(notice.textContent).toContain("check before recording it again");
  });

  /**
   * Review SF-5. The message being right is only half of it: on this surface the
   * operator's likeliest next act is a second press on the same button, and a
   * toast that has already faded cannot stop it. So the sentence is HELD in the
   * open dialog, the recording buttons are disarmed behind it, and the way out
   * is named "Close" rather than "Cancel" — there may be nothing left to cancel.
   */
  it("holds the message in the dialog and disarms the recording buttons behind it", async () => {
    const fetchMock = openAndFailTheRecording();

    const notice = await screen.findByText(UNVERIFIED);

    // Not a toast: the region is the house recovery alert, it stays on screen,
    // and it TAKES FOCUS — the button just pressed is disabled behind it, and a
    // control disabled in the same turn cannot hold focus, so without this the
    // operator would be dropped to <body> with no explanation in reach.
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(UNVERIFIED);
    await expectRecoveryAlertToHoldFocus(notice);
    // The dialog did not close out from under the message.
    expect(
      screen.getByText(/Record \$120\.00 as paid for Ada Lovelace\?/)
    ).toBeTruthy();

    const record = screen.getByRole("button", {
      name: "Record and email member",
    });
    expect(record).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Record without emailing" })
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close and check" })).toBeTruthy();

    // A reflexive second press sends nothing — the one attempt is all that was
    // made, so the booking cannot collect a duplicate cash record from here.
    fireEvent.click(record);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears the notice when the dialog is reopened", async () => {
    openAndFailTheRecording();
    await screen.findByText(UNVERIFIED);

    fireEvent.click(screen.getByRole("button", { name: "Close and check" }));
    await waitFor(() => expect(screen.queryByText(UNVERIFIED)).toBeNull());

    fireEvent.click(
      screen.getByRole("button", { name: /Record manual payment/i })
    );
    // A stale notice over a fresh dialog would read as this press's outcome.
    expect(screen.queryByText(UNVERIFIED)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Record and email member" })
    ).toBeEnabled();
  });
});
