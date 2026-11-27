// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { BookingChangeRequestsPanel } from "@/components/admin/booking-requests/booking-change-requests-panel";

/**
 * #4030 Part B: a free-text request on a finished stay names nobody, so the
 * officer enters the guests the member described on the card. The figures are
 * worked out for exactly that list, and Approve and apply sends it.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function freeTextRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    bookingId: "bk-1",
    requestedByMemberId: "m-1",
    status: "REQUESTED",
    version: 2,
    executesOnApproval: true,
    acceptsOfficerGuests: true,
    requestedChanges: { requested: { summary: "effective 2026-06-10", addGuests: [] } },
    reason: "Can we add these three grandchildren to our booking",
    adminNotes: null,
    internalNotes: null,
    reviewedAt: null,
    createdAt: "2026-06-10T10:00:00.000Z",
    requestedBy: { id: "m-1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
    reviewedBy: null,
    linkedModification: null,
    booking: {
      id: "bk-1",
      checkIn: "2026-06-10T00:00:00.000Z",
      checkOut: "2026-06-14T00:00:00.000Z",
      status: "COMPLETED",
      finalPriceCents: 12000,
      member: { id: "m-1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
      organisation: null,
      payment: null,
    },
    ...overrides,
  };
}

const QUOTE = {
  priceDiffCents: 8_000,
  changeFeeCents: 0,
  additionalAmountCents: 8_000,
  refundAmountCents: 0,
  accountCreditAmountCents: 0,
  capacityOverridden: false,
  settlementMethod: "card",
};

let rows: Array<Record<string, unknown>>;
let memberGuestFind: { openSearchEnabled: boolean } | null;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  rows = [freeTextRequest()];
  memberGuestFind = null;
  fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/member-guest-candidates")) {
      return jsonResponse({
        candidates: [
          { memberId: "m-1", firstName: "Ada", lastName: "Lovelace", ageTier: "ADULT" },
          { memberId: "m-9", firstName: "Kit", lastName: "Lovelace", ageTier: "CHILD" },
        ],
      });
    }
    if (url.endsWith("/quote")) return jsonResponse({ id: "req-1", quote: QUOTE });
    if (init?.method === "PATCH") {
      return jsonResponse({
        id: "req-1",
        execution: { executed: true, followUpFailed: false, officerEnteredGuestCount: 1 },
      });
    }
    if (url.includes("/api/admin/booking-change-requests")) {
      return jsonResponse({ data: rows, page: 1, pageSize: 25, total: rows.length, memberGuestFind });
    }
    return jsonResponse({});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function bodies(match: (url: string, init: RequestInit | undefined) => boolean) {
  return fetchMock.mock.calls
    .filter(([input, init]) => match(String(input), init as RequestInit | undefined))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}
const quoteBodies = () => bodies((url, init) => url.endsWith("/quote") && init?.method === "POST");
const patchBodies = () => bodies((url, init) => url.endsWith("req-1") && init?.method === "PATCH");

async function enterGuest(firstName: string) {
  fireEvent.change(await screen.findByLabelText("First name"), { target: { value: firstName } });
  fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Example" } });
  fireEvent.change(screen.getByLabelText("Age"), { target: { value: "CHILD" } });
  fireEvent.click(screen.getByRole("button", { name: "Add guest" }));
}

describe("change-request panel — the officer enters the guests (#4030)", () => {
  it("offers the entry only on a request that takes one", async () => {
    rows = [freeTextRequest({ acceptsOfficerGuests: false })];
    render(<BookingChangeRequestsPanel />);
    await screen.findByRole("button", { name: "Approve and apply" });
    expect(screen.queryByText(/Guests the member asked to add/)).toBeNull();
    expect(screen.queryByLabelText("First name")).toBeNull();
  });

  it("prices the entered guests and sends them with the approval", async () => {
    render(<BookingChangeRequestsPanel />);
    expect(await screen.findByText(/Guests the member asked to add/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Explanation for the member/i), {
      target: { value: "Added your grandchildren." },
    });
    await enterGuest("Ari");
    // Nights bounded to the stay.
    expect(screen.getByLabelText("Date In")).toHaveAttribute("min", "2026-06-10");
    expect(screen.getByLabelText("Date Out")).toHaveAttribute("max", "2026-06-14");
    fireEvent.change(screen.getByLabelText("Date In"), { target: { value: "2026-06-11" } });

    const approve = screen.getByRole("button", { name: "Approve and apply" });
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Check the figures/i }));
    await screen.findByRole("list", { name: /What approving will do/i });
    const ari = {
      firstName: "Ari",
      lastName: "Example",
      ageTier: "CHILD",
      isMember: false,
      stayStart: "2026-06-11",
      stayEnd: "2026-06-14",
    };
    expect(quoteBodies()[0]).toEqual({ officerGuests: [ari] });
    expect(approve).not.toBeDisabled();

    fireEvent.click(approve);
    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]).toEqual({
      status: "APPROVED",
      execute: true,
      adminNotes: "Added your grandchildren.",
      expectedVersion: 2,
      officerGuests: [ari],
      expectedFigures: { additionalAmountCents: 8_000, refundAmountCents: 0, accountCreditAmountCents: 0 },
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/recorded on the member's behalf/i)),
    );
  });

  it("figures for one list never arm the approval of another", async () => {
    render(<BookingChangeRequestsPanel />);
    fireEvent.change(await screen.findByLabelText(/Explanation for the member/i), {
      target: { value: "ok" },
    });
    await enterGuest("Ari");
    fireEvent.click(screen.getByRole("button", { name: /Check the figures/i }));
    await screen.findByRole("list", { name: /What approving will do/i });
    const approve = screen.getByRole("button", { name: "Approve and apply" });
    expect(approve).not.toBeDisabled();
    await enterGuest("Bo");
    expect(approve).toBeDisabled();
  });

  it("a rejection carries no entry", async () => {
    render(<BookingChangeRequestsPanel />);
    fireEvent.change(await screen.findByLabelText(/Explanation for the member/i), {
      target: { value: "Please call the club." },
    });
    await enterGuest("Ari");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]).not.toHaveProperty("officerGuests");
  });

  it("disables, in the officer's member finder, a member already on the booking", async () => {
    memberGuestFind = { openSearchEnabled: false };
    rows = [
      freeTextRequest({
        booking: { ...freeTextRequest().booking, guests: [{ memberId: "m-1" }] },
      }),
    ];
    render(<BookingChangeRequestsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Add a member" }));
    fireEvent.change(screen.getByPlaceholderText("their email address"), { target: { value: "lovelace@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    const owner = await screen.findByRole("option", { name: /Ada Lovelace/ });
    expect(owner).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("option", { name: /Kit Lovelace/ })).not.toHaveAttribute("aria-disabled");
    // The lookup went to the booking's own admin finder route.
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).startsWith("/api/admin/bookings/bk-1/member-guest-candidates"),
      ),
    ).toBe(true);
  });

  it("drops figures that moved under the officer, so Approve waits for a fresh check (review C4)", async () => {
    let approvals = 0;
    const base = fetchMock.getMockImplementation() as (input: unknown, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("req-1") && init?.method === "PATCH") {
        approvals += 1;
        return jsonResponse(
          { id: "req-1", status: "REQUESTED", keptPending: true, code: "FIGURES_CHANGED", error: "The figures changed since you checked them." },
          409,
        );
      }
      return base(input, init);
    });
    render(<BookingChangeRequestsPanel />);
    fireEvent.change(await screen.findByLabelText(/Explanation for the member/i), { target: { value: "ok" } });
    await enterGuest("Ari");
    fireEvent.click(screen.getByRole("button", { name: /Check the figures/i }));
    await screen.findByRole("list", { name: /What approving will do/i });
    const approve = screen.getByRole("button", { name: "Approve and apply" });
    fireEvent.click(approve);
    expect(await screen.findByText(/The figures changed since you checked them/)).toBeInTheDocument();
    expect(approvals).toBe(1);
    await waitFor(() => expect(approve).toBeDisabled());
    expect(screen.queryByRole("list", { name: /What approving will do/i })).toBeNull();
  });

  it("an overbooking confirmed for one list is not sent for another (review M1)", async () => {
    const base = fetchMock.getMockImplementation() as (input: unknown, init?: RequestInit) => Promise<Response>;
    let quoteCalls = 0;
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/quote")) {
        quoteCalls += 1;
        if (quoteCalls === 1) {
          return jsonResponse(
            {
              id: "req-1",
              status: "REQUESTED",
              keptPending: true,
              needsCapacityConfirmation: true,
              nightDetails: [{ date: "2026-06-11", availableBeds: -1 }],
              error: "Some of this stay's nights are over the lodge's capacity.",
            },
            409,
          );
        }
      }
      return base(input, init);
    });
    render(<BookingChangeRequestsPanel />);
    fireEvent.change(await screen.findByLabelText(/Explanation for the member/i), { target: { value: "ok" } });
    await enterGuest("Ari");
    fireEvent.click(screen.getByRole("button", { name: /Check the figures/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Confirm overbooking/i }));
    await screen.findByRole("list", { name: /What approving will do/i });
    expect(quoteBodies()[1]).toMatchObject({ confirmOverCapacity: true });

    // A different list: the confirmation (and the stale warning) go with the old one.
    await enterGuest("Bo");
    expect(screen.queryByRole("button", { name: /Confirm overbooking/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Check the figures/i }));
    await screen.findByRole("list", { name: /What approving will do/i });
    expect(quoteBodies()[2]).not.toHaveProperty("confirmOverCapacity");
    expect(quoteBodies()[2].officerGuests).toHaveLength(2);
  });

  it("a quote reply that lands after the list changed is dropped (re-review of 72c933ffc)", async () => {
    const base = fetchMock.getMockImplementation() as (input: unknown, init?: RequestInit) => Promise<Response>;
    let quoteCalls = 0;
    let releaseLate!: () => void;
    const late = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/quote")) {
        quoteCalls += 1;
        if (quoteCalls === 1) {
          return jsonResponse(
            {
              id: "req-1",
              status: "REQUESTED",
              keptPending: true,
              needsCapacityConfirmation: true,
              nightDetails: [{ date: "2026-06-11", availableBeds: -1 }],
              error: "Some of this stay's nights are over the lodge's capacity.",
            },
            409,
          );
        }
        // The confirmed quote for the first list: held until the list changes.
        if (quoteCalls === 2) {
          await late;
          return jsonResponse({ id: "req-1", quote: QUOTE });
        }
      }
      return base(input, init);
    });
    render(<BookingChangeRequestsPanel />);
    fireEvent.change(await screen.findByLabelText(/Explanation for the member/i), { target: { value: "ok" } });
    await enterGuest("Ari");
    fireEvent.click(screen.getByRole("button", { name: /Check the figures/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Confirm overbooking/i }));
    await waitFor(() => expect(quoteBodies()).toHaveLength(2));
    expect(quoteBodies()[1]).toMatchObject({ confirmOverCapacity: true });

    // The officer changes the list while that confirmed quote is in flight.
    await enterGuest("Bo");
    releaseLate();
    await late;
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Nothing from the old list's reply came back: no figures, and the next
    // check for the new list carries no overbooking confirmation.
    expect(screen.queryByRole("list", { name: /What approving will do/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Approve and apply" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Check the figures/i }));
    await waitFor(() => expect(quoteBodies()).toHaveLength(3));
    expect(quoteBodies()[2]).not.toHaveProperty("confirmOverCapacity");
    expect(quoteBodies()[2].officerGuests).toHaveLength(2);
  });

  it("follows the queue's view-only pattern for an admin who cannot edit (review S6)", async () => {
    render(<BookingChangeRequestsPanel canEdit={false} />);
    const firstName = await screen.findByLabelText("First name");
    expect(firstName).toBeDisabled();
    expect(firstName).toHaveAttribute("title", expect.stringMatching(/.+/));
    // The buttons are the section's view-only button: disabled, explained once
    // by the banner at the top of the section.
    expect(screen.getByRole("button", { name: "Add guest" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/cannot approve or reject/);
  });
});
