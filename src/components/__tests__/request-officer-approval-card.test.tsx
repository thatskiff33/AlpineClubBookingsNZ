// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it, vi } from "vitest";

import {
  RequestOfficerApprovalCard,
  type ExceptionRequestProposalView,
} from "@/components/booking/request-officer-approval-card";
import type { ExceptionOffer } from "@/lib/booking-exception-offer";

/**
 * #2562 — the member's submission screen.
 *
 * What the owner's decision is specific about, and what is therefore pinned here:
 * the exact proposal is on screen before submitting; the explanation is mandatory;
 * the "not approved yet" and "discretionary" statements are both present; the
 * capacity sentence is the honest one for the path; a new-booking request never
 * claims to hold beds; and after submitting, the member is shown the proposal the
 * SERVER froze rather than the one they typed.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const OFFER: ExceptionOffer = {
  code: "MINIMUM_STAY_VIOLATION",
  message: "Booking does not meet minimum stay requirement",
  capacityMode: "HOLD",
  violations: [
    {
      reasonCode: "MINIMUM_STAY",
      message: "Friday nights need a two-night booking.",
      affectedNights: ["2026-07-03"],
      capacityMode: "HOLD",
    },
  ],
};

function proposal(
  overrides: Partial<ExceptionRequestProposalView> = {},
): ExceptionRequestProposalView {
  return {
    lodgeName: "Ruapehu Lodge",
    checkIn: "2026-07-03",
    checkOut: "2026-07-04",
    envelopeNightCount: 1,
    base: null,
    priceImpact: { label: "Total for this stay", amountCents: 12000 },
    omittedChanges: [],
    guests: [
      {
        firstName: "Sam",
        lastName: "Skier",
        ageTierLabel: "Adult (18+)",
        isMember: true,
        nights: [],
        stay: null,
      },
    ],
    ...overrides,
  };
}

/** The frozen article the create call answers with. */
function submitResult(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    capacityHeld: false,
    proposal: {
      lodgeId: "lodge-1",
      checkIn: "2026-07-03",
      checkOut: "2026-07-04",
      guests: [
        {
          firstName: "Sam",
          lastName: "Skier",
          ageTier: "ADULT",
          isMember: true,
          nights: ["2026-07-03"],
        },
      ],
      guestNights: 1,
      baseCheckIn: null,
      baseCheckOut: null,
      baseGuestNights: null,
    },
    ...overrides,
  };
}

function renderCard(
  props: Partial<React.ComponentProps<typeof RequestOfficerApprovalCard>> = {},
) {
  const onSubmit = vi.fn().mockResolvedValue(submitResult());
  const view = render(
    <RequestOfficerApprovalCard
      source="NEW_BOOKING"
      offer={OFFER}
      proposal={proposal()}
      onSubmit={onSubmit}
      {...props}
    />,
  );
  return { ...view, onSubmit };
}

describe("RequestOfficerApprovalCard — what the member is shown before submitting", () => {
  it("names the rule and quotes the policy's own sentence", () => {
    renderCard();
    expect(screen.getByText(/Minimum length of stay/i)).toBeInTheDocument();
    expect(
      screen.getByText("Friday nights need a two-night booking."),
    ).toBeInTheDocument();
    // The server's refusal sentence is shown verbatim rather than re-worded.
    expect(
      screen.getByText("Booking does not meet minimum stay requirement"),
    ).toBeInTheDocument();
  });

  it("shows the exact proposal: lodge, dates, guests and the guest-night total", () => {
    renderCard();
    expect(screen.getByText("Ruapehu Lodge")).toBeInTheDocument();
    expect(screen.getByText(/Sam Skier/)).toBeInTheDocument();
    expect(screen.getByText(/Adult \(18\+\)/)).toBeInTheDocument();
    // One guest on the whole stay of one night.
    expect(screen.getByText(/1 across 1 guest/)).toBeInTheDocument();
    expect(screen.getByText(/the whole stay/)).toBeInTheDocument();
  });

  it("counts a guest's own picked nights and a guest's own picked range", () => {
    renderCard({
      proposal: proposal({
        envelopeNightCount: 3,
        guests: [
          {
            firstName: "Sam",
            lastName: "Skier",
            ageTierLabel: "Adult (18+)",
            isMember: true,
            nights: ["2026-07-03", "2026-07-05"],
            stay: null,
          },
          {
            firstName: "Robin",
            lastName: "Visitor",
            ageTierLabel: "Youth (10-17)",
            isMember: false,
            nights: [],
            stay: { start: "2026-07-03", end: "2026-07-04" },
          },
          {
            firstName: "Jo",
            lastName: "Guest",
            ageTierLabel: "Adult (18+)",
            isMember: false,
            nights: [],
            stay: null,
          },
        ],
      }),
    });
    // 2 picked nights + a 1-night range + the 3-night whole stay.
    expect(screen.getByText(/6 across 3 guests/)).toBeInTheDocument();
  });

  it("labels the price as the club's quote, never as an agreed figure", () => {
    renderCard();
    expect(screen.getByText(/Total for this stay/)).toBeInTheDocument();
    expect(screen.getByText(/\$120\.00/)).toBeInTheDocument();
    expect(
      screen.getByText(/nothing is charged while the request waits/i),
    ).toBeInTheDocument();
  });

  it("says how pricing works instead of inventing a figure when the server never quoted", () => {
    renderCard({ proposal: proposal({ priceImpact: null }) });
    expect(
      screen.getByText(/Worked out at the club's normal rates/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it("states plainly that nothing is booked and that approval is discretionary", () => {
    renderCard();
    expect(
      screen.getByText(/does not book anything and does not confirm anything/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/allow exceptions at their discretion/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/no guarantee/i)).toBeInTheDocument();
  });

  it("tells the member a submitted request is replaced, not edited", () => {
    renderCard();
    expect(
      screen.getByText(/cannot be edited after you send it/i),
    ).toBeInTheDocument();
  });

  it("names the parts of a change a request cannot carry", () => {
    renderCard({
      source: "MODIFICATION",
      proposal: proposal({
        omittedChanges: ["guest name corrections", "the promo code"],
      }),
    });
    const notice = screen.getByText(/are NOT included/i);
    expect(notice).toHaveTextContent("guest name corrections");
    expect(notice).toHaveTextContent("the promo code");
  });
});

describe("RequestOfficerApprovalCard — capacity honesty", () => {
  it("never promises held beds on a new-booking request, even in HOLD mode", () => {
    renderCard();
    // HOLD is the offer's aggregate mode, and it still holds nothing here: the
    // reservation ledger is keyed on an existing booking.
    expect(screen.getByText(/No beds are held by this request/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Availability is checked again when a Booking Officer reviews it/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/beds are held while/i)).toBeNull();
  });

  it("states the modification's real hold and that approval cannot oversell", () => {
    renderCard({ source: "MODIFICATION" });
    const capacity = screen.getByText(/held while the request waits/i);
    expect(capacity).toBeInTheDocument();
    // Said in the capacity sentence itself, not only in the discretionary notice
    // further down — the member reading about their beds must read it there.
    expect(capacity).toHaveTextContent(/never put the lodge over capacity/i);
  });

  it("promises nothing on a NO_HOLD modification", () => {
    renderCard({
      source: "MODIFICATION",
      offer: { ...OFFER, capacityMode: "NO_HOLD" },
    });
    expect(
      screen.getByText(/No extra beds are held by this request/i),
    ).toBeInTheDocument();
  });

  /**
   * #2562 review — the mandated notice pointed the wrong way.
   *
   * It ended "Nothing is reserved by the request itself except where it says
   * otherwise below", and the card draws the capacity sentence ABOVE it. So a member
   * on the modification HOLD path — the one case where something IS reserved — read
   * the denial, looked below for the exception it promised, and found nothing about
   * reservations at all; a member on the new-booking path was left wondering what
   * the exception had been. The direction is asserted against the rendered DOM
   * order, not just the constant, because the constant is only right relative to a
   * layout.
   */
  it("points at the capacity sentence in the direction it is actually rendered", () => {
    const { container } = renderCard({ source: "MODIFICATION" });
    const capacity = screen.getByText(/held while the request waits/i);
    const notice = screen.getByText(/Nothing is reserved by the request itself/i);

    expect(notice).toHaveTextContent(/the note above says otherwise/i);
    expect(notice).not.toHaveTextContent(/below/i);
    // Node order: the exception really is above the sentence that cites it.
    expect(
      capacity.compareDocumentPosition(notice) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container).toBeTruthy();
  });
});

describe("RequestOfficerApprovalCard — submitting", () => {
  it("requires an explanation before the button does anything", () => {
    const { onSubmit } = renderCard();
    const button = screen.getByRole("button", {
      name: /Request Booking Officer approval/i,
    });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("treats whitespace as no explanation", () => {
    renderCard();
    fireEvent.change(screen.getByLabelText(/Why are you asking/i), {
      target: { value: "   " },
    });
    expect(
      screen.getByRole("button", { name: /Request Booking Officer approval/i }),
    ).toBeDisabled();
  });

  it("sends the trimmed explanation and no supersede id by default", async () => {
    const { onSubmit } = renderCard();
    fireEvent.change(screen.getByLabelText(/Why are you asking/i), {
      target: { value: "  Driving up after work.  " },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Request Booking Officer approval/i }),
    );
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        memberMessage: "Driving up after work.",
        supersedeRequestId: null,
      }),
    );
  });

  it("passes the request being replaced straight through, and says so on the button", async () => {
    const { onSubmit } = renderCard({ replaceRequestId: "req-old" });
    expect(
      screen.getByText(/Replace your request to a Booking Officer/i),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Why are you asking/i), {
      target: { value: "Corrected the dates." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Replace my request/i }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        memberMessage: "Corrected the dates.",
        supersedeRequestId: "req-old",
      }),
    );
  });

  it("shows the SERVER's frozen proposal after submitting, not the typed one", async () => {
    const onSubmit = vi.fn().mockResolvedValue(
      submitResult({
        proposal: {
          lodgeId: "lodge-1",
          // The freeze expanded the envelope to cover a guest night the member's
          // own dates did not include. This is exactly the case the member has to
          // be shown, while withdraw and replace are still open.
          checkIn: "2026-07-03",
          checkOut: "2026-07-06",
          guests: [
            {
              firstName: "Sam",
              lastName: "Skier",
              ageTier: "ADULT",
              isMember: true,
              nights: ["2026-07-03", "2026-07-04", "2026-07-05"],
            },
          ],
          guestNights: 3,
          baseCheckIn: null,
          baseCheckOut: null,
          baseGuestNights: null,
        },
      }),
    );
    render(
      <RequestOfficerApprovalCard
        source="NEW_BOOKING"
        offer={OFFER}
        proposal={proposal()}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Why are you asking/i), {
      target: { value: "Please." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Request Booking Officer approval/i }),
    );

    const sent = await screen.findByTestId("exception-request-sent");
    expect(sent).toHaveTextContent("Exactly what the Booking Officer will decide");
    expect(sent).toHaveTextContent("3 guest nights");
    expect(sent).toHaveTextContent(/is not booked and it is not confirmed/i);
    // And the way to track, withdraw or replace it.
    expect(sent).toHaveTextContent(/My booking-rule requests/i);
  });

  it("points an already-open-request conflict at the replace flow, not at retrying", async () => {
    const failure = new Error(
      "A booking-policy exception request is already open.",
    ) as Error & { code?: string };
    failure.code = "OPEN_EXCEPTION_REQUEST";
    renderCard({ onSubmit: vi.fn().mockRejectedValue(failure) });
    fireEvent.change(screen.getByLabelText(/Why are you asking/i), {
      target: { value: "Please." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Request Booking Officer approval/i }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("already open");
    expect(alert).toHaveTextContent(/replace the request you already have/i);
  });

  it("explains a lost supersede claim as 'nothing new was sent'", async () => {
    const failure = new Error(
      "The request you tried to replace is no longer open.",
    ) as Error & { code?: string };
    failure.code = "LOST_SUPERSEDE_CLAIM";
    renderCard({
      replaceRequestId: "req-old",
      onSubmit: vi.fn().mockRejectedValue(failure),
    });
    fireEvent.change(screen.getByLabelText(/Why are you asking/i), {
      target: { value: "Please." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Replace my request/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/no longer open/i);
    expect(alert).toHaveTextContent(/nothing new was sent/i);
  });

  it("shows the server's own sentence for any other failure, and stays on the form", async () => {
    renderCard({
      onSubmit: vi
        .fn()
        .mockRejectedValue(new Error("The lodge does not currently have room.")),
    });
    fireEvent.change(screen.getByLabelText(/Why are you asking/i), {
      target: { value: "Please." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Request Booking Officer approval/i }),
    );
    expect(
      await screen.findByText("The lodge does not currently have room."),
    ).toBeInTheDocument();
    // Not a success state: the form is still there to try again from.
    expect(screen.queryByTestId("exception-request-sent")).toBeNull();
  });
});
