// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MyExceptionRequests,
  replaceRequestHref,
} from "@/app/(authenticated)/bookings/_components/my-exception-requests";
import type { MemberExceptionRequestItem } from "@/lib/member-exception-requests";

/**
 * #2562 — the member's request-management area.
 *
 * The owner's decision lists what this has to show, and its acceptance criteria
 * name the one thing it must never do: invent a decision. A REQUESTED row with a
 * recorded conflict reads as "the lodge was full", not as "nobody has looked". The
 * internal officer note has no route here at all — the DTO has no field for it —
 * and that is asserted rather than assumed.
 */

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function request(
  overrides: Partial<MemberExceptionRequestItem> = {},
): MemberExceptionRequestItem {
  return {
    id: "req-1",
    source: "NEW_BOOKING",
    status: "pending",
    createdAt: "2026-07-01T10:00:00.000Z",
    reviewedAt: null,
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
    rules: [
      {
        reasonCode: "MINIMUM_STAY",
        message: "Friday nights need a two-night booking.",
        affectedNights: ["2026-07-03"],
      },
    ],
    memberMessage: "Driving up after work.",
    decisionExplanation: null,
    capacityHeld: false,
    // A new-booking request reserves nothing, so NO_HOLD is its real frozen mode.
    capacityMode: "NO_HOLD",
    lastConflictReason: null,
    lastConflictAt: null,
    bookingId: null,
    createdBookingId: null,
    // No booking was created, so there is no created-booking capacity answer and no
    // payable state either.
    createdBookingHoldsCapacity: null,
    createdBookingAwaitsPayment: null,
    supersededByRequestId: null,
    canWithdraw: true,
    canReplace: true,
    ...overrides,
  };
}

beforeEach(() => {
  routerRefresh.mockClear();
  global.fetch = vi.fn(async () => jsonResponse({ id: "req-1", status: "CANCELLED" })) as
    unknown as typeof fetch;
});

describe("MyExceptionRequests — what each state reads as", () => {
  it("renders nothing at all when the member has no requests", () => {
    const { container } = render(<MyExceptionRequests requests={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("reads a plain pending request as undecided, and promises no beds", () => {
    render(<MyExceptionRequests requests={[request()]} />);
    expect(screen.getByText("With the Booking Officer")).toBeInTheDocument();
    expect(screen.getByText(/has not decided yet/i)).toBeInTheDocument();
    expect(screen.getByText(/No beds are held/i)).toBeInTheDocument();
  });

  it("reads a conflicted pending request as 'the lodge was full', never as unlooked-at", () => {
    render(
      <MyExceptionRequests
        requests={[
          request({
            status: "pending-capacity-conflict",
            lastConflictReason: "The lodge is full on 3 July.",
            lastConflictAt: "2026-07-02T09:00:00.000Z",
          }),
        ]}
      />,
    );
    expect(screen.getByText("Waiting — the lodge was full")).toBeInTheDocument();
    expect(screen.getByText(/did not have room/i)).toBeInTheDocument();
    // The lodge's own recorded reason, with its time.
    expect(
      screen.getByText(/The lodge is full on 3 July/),
    ).toBeInTheDocument();
    // And it must NOT read as undecided.
    expect(screen.queryByText(/has not decided yet/i)).toBeNull();
  });

  it("shows a refusal with the officer's member-facing explanation", () => {
    render(
      <MyExceptionRequests
        requests={[
          request({
            status: "refused",
            canWithdraw: false,
            canReplace: false,
            reviewedAt: "2026-07-02T09:00:00.000Z",
            decisionExplanation: "That weekend is always full, sorry.",
          }),
        ]}
      />,
    );
    expect(screen.getByText("Not approved")).toBeInTheDocument();
    expect(screen.getByText("What the Booking Officer said")).toBeInTheDocument();
    expect(
      screen.getByText("That weekend is always full, sorry."),
    ).toBeInTheDocument();
    expect(screen.getByText(/No beds are held for this request any more/i))
      .toBeInTheDocument();
  });

  it("links an approved request to the booking it created", () => {
    render(
      <MyExceptionRequests
        requests={[
          request({
            status: "approved",
            canWithdraw: false,
            canReplace: false,
            createdBookingId: "booking-9",
          }),
        ]}
      />,
    );
    expect(screen.getByText("Approved and booked")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open the booking/i })).toHaveAttribute(
      "href",
      "/bookings/booking-9",
    );
  });

  /**
   * #2562 re-review — the row passes the booking's PAYABLE state through, not just
   * its capacity answer.
   *
   * Both are false for a booking that was cancelled or reaped, and the row used to
   * read the capacity answer as "unpaid": it told the member to open it and pay it,
   * or lose the nights to somebody else, about a booking that could not be paid.
   */
  it("only asks the member to pay an approved booking that can still be paid", () => {
    const approved = {
      status: "approved" as const,
      canWithdraw: false,
      canReplace: false,
      createdBookingId: "booking-9",
      createdBookingHoldsCapacity: false,
    };
    const { unmount } = render(
      <MyExceptionRequests
        requests={[request({ ...approved, createdBookingAwaitsPayment: true })]}
      />,
    );
    expect(screen.getByText(/Open it and pay it/i)).toBeInTheDocument();
    unmount();

    render(
      <MyExceptionRequests
        requests={[request({ ...approved, createdBookingAwaitsPayment: false })]}
      />,
    );
    expect(screen.getByText(/no longer live/i)).toBeInTheDocument();
    expect(screen.queryByText(/Open it and pay it/i)).toBeNull();
  });

  it("has a distinct word for withdrawn, replaced and lapsed", () => {
    render(
      <MyExceptionRequests
        requests={[
          request({ id: "a", status: "withdrawn", canWithdraw: false, canReplace: false }),
          request({ id: "b", status: "superseded", canWithdraw: false, canReplace: false }),
          request({ id: "c", status: "expired", canWithdraw: false, canReplace: false }),
        ]}
      />,
    );
    expect(screen.getByText("Withdrawn by you")).toBeInTheDocument();
    expect(screen.getByText("Replaced by a newer request")).toBeInTheDocument();
    expect(screen.getByText("Lapsed")).toBeInTheDocument();
  });

  it("shows the exact proposal and the member's own explanation", () => {
    render(<MyExceptionRequests requests={[request()]} />);
    expect(screen.getByText("What you asked for")).toBeInTheDocument();
    expect(screen.getByText(/1 guest nights across 1 guest/)).toBeInTheDocument();
    expect(screen.getByText(/Sam Skier/)).toBeInTheDocument();
    expect(screen.getByText("What you told the officer")).toBeInTheDocument();
    expect(screen.getByText("Driving up after work.")).toBeInTheDocument();
    // The rule, with the policy's own sentence.
    expect(
      screen.getByText(/Friday nights need a two-night booking/),
    ).toBeInTheDocument();
  });

  it("shows a modification's base envelope so the member sees what is changing", () => {
    render(
      <MyExceptionRequests
        requests={[
          request({
            source: "MODIFICATION",
            bookingId: "booking-1",
            proposal: {
              ...request().proposal,
              baseCheckIn: "2026-08-01",
              baseCheckOut: "2026-08-03",
              baseGuestNights: 2,
            },
          }),
        ]}
      />,
    );
    expect(screen.getByText(/The booking today:/)).toBeInTheDocument();
    expect(screen.getByText(/2 guest nights/)).toBeInTheDocument();
  });

  it("says so plainly when the stored proposal cannot be read", () => {
    render(
      <MyExceptionRequests
        requests={[
          request({
            proposal: { ...request().proposal, guests: [], guestNights: 0 },
          }),
        ]}
      />,
    );
    expect(
      screen.getByText(/saved details of this request cannot be read/i),
    ).toBeInTheDocument();
  });
});

describe("MyExceptionRequests — the internal note never arrives", () => {
  it("renders nothing from an internalNotes property, even if one is attached", () => {
    // The DTO has no such field, so this is a defence-in-depth check on the render:
    // the component reads named fields and never spreads the item.
    render(
      <MyExceptionRequests
        requests={[
          {
            ...request({
              status: "refused",
              canWithdraw: false,
              canReplace: false,
              decisionExplanation: "Not this weekend.",
            }),
            internalNotes: "This member asks every single season.",
          } as unknown as MemberExceptionRequestItem,
        ]}
      />,
    );
    expect(screen.getByText("Not this weekend.")).toBeInTheDocument();
    expect(screen.queryByText(/every single season/)).toBeNull();
  });
});

describe("MyExceptionRequests — withdraw", () => {
  it("asks before withdrawing, then calls the member's own cancel endpoint", async () => {
    render(<MyExceptionRequests requests={[request()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    // Confirmation first: withdrawing closes the request for good.
    expect(screen.getByText(/Withdraw this request\?/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Yes, withdraw it/i }));
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    const [url, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe("/api/bookings/exception-requests/req-1");
    expect(init).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      action: "cancel",
    });
  });

  it("uses the booking-scoped endpoint for a modification request", async () => {
    render(
      <MyExceptionRequests
        requests={[request({ source: "MODIFICATION", bookingId: "booking-1" })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    fireEvent.click(screen.getByRole("button", { name: /Yes, withdraw it/i }));
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toBe("/api/bookings/booking-1/exception-requests/req-1");
  });

  it("shows the server's own sentence when the claim is lost, and does not refresh", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(
        { error: "This request is no longer open and cannot be cancelled" },
        409,
      ),
    ) as unknown as typeof fetch;
    render(<MyExceptionRequests requests={[request()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    fireEvent.click(screen.getByRole("button", { name: /Yes, withdraw it/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "no longer open and cannot be cancelled",
    );
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("offers neither action on a decided request", () => {
    render(
      <MyExceptionRequests
        requests={[request({ status: "approved", canWithdraw: false, canReplace: false })]}
      />,
    );
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
    expect(
      screen.queryByRole("link", { name: /Replace with a corrected request/i }),
    ).toBeNull();
  });
});

describe("MyExceptionRequests — replace", () => {
  it("sends a new-booking replacement back to the wizard that built it", () => {
    render(<MyExceptionRequests requests={[request()]} />);
    expect(
      screen.getByRole("link", { name: /Replace with a corrected request/i }),
    ).toHaveAttribute("href", "/book?replaceRequest=req-1");
  });

  it("sends a modification replacement back to its own booking", () => {
    render(
      <MyExceptionRequests
        requests={[request({ source: "MODIFICATION", bookingId: "booking-1" })]}
      />,
    );
    const row = screen.getByTestId("exception-request-row");
    expect(
      within(row).getByRole("link", { name: /Replace with a corrected request/i }),
    ).toHaveAttribute("href", "/bookings/booking-1?replaceRequest=req-1");
  });

  it("explains that changing material details means replacing, not editing", () => {
    render(<MyExceptionRequests requests={[request()]} />);
    expect(
      screen.getByText(/cannot be edited after you send it/i),
    ).toBeInTheDocument();
  });

  it("escapes the request id in the replace link", () => {
    // Ids are cuids, so this can only bite through a hand-made or migrated id — but
    // a link that silently truncates on an ampersand is a lost replacement.
    expect(
      replaceRequestHref(request({ id: "a&b=c" })),
    ).toBe("/book?replaceRequest=a%26b%3Dc");
  });
});
