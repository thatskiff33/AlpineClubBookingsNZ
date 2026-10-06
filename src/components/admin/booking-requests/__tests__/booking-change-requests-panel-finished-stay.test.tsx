// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { BookingChangeRequestsPanel } from "@/components/admin/booking-requests/booking-change-requests-panel";

/**
 * #3750: on a FINISHED stay, approving a locked-period change request APPLIES it
 * (owner decision, 6 Oct 2026). The panel must say so before the officer clicks,
 * must stop telling them to "apply the change on the booking page" — which a
 * finished stay cannot do — and must let them confirm an over-capacity past
 * night on the card that asked.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function changeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    bookingId: "bk-1",
    requestedByMemberId: "m-1",
    status: "REQUESTED",
    version: 4,
    executesOnApproval: true,
    requestedChanges: { requested: { summary: "add Late Guest" } },
    reason: "Our niece stayed too.",
    adminNotes: null,
    internalNotes: null,
    reviewedAt: null,
    createdAt: "2026-06-12T10:00:00.000Z",
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
      payment: null,
    },
    ...overrides,
  };
}

let rows: Array<Record<string, unknown>>;
let patchResponses: Response[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  rows = [changeRequest()];
  patchResponses = [];
  fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      return patchResponses.shift() ?? jsonResponse({ id: "req-1" });
    }
    if (String(input).includes("/api/admin/booking-change-requests")) {
      return jsonResponse({ data: rows, page: 1, pageSize: 25, total: rows.length });
    }
    return jsonResponse({});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function patchBodies(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

async function writeMemberNote() {
  fireEvent.change(await screen.findByLabelText(/Explanation for the member/i), {
    target: { value: "We have added your niece to the stay." },
  });
}

describe("change-request panel on a finished stay (#3750)", () => {
  it("says approving applies the change, and never sends the officer to the booking page", async () => {
    render(<BookingChangeRequestsPanel />);
    expect(await screen.findByRole("button", { name: "Approve and apply" })).toBeInTheDocument();
    expect(screen.getByText(/approving applies the request to the booking/i)).toBeInTheDocument();
    expect(screen.queryByText(/apply the change there/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Acknowledge as approved/i })).toBeNull();
    // An executed approval links its own modification.
    expect(screen.queryByLabelText(/Linked booking modification id/i)).toBeNull();
    expect(screen.getByLabelText(/If the change lowers the price/i)).toBeInTheDocument();
  });

  it("sends the screen's version and the refund choice with the approval", async () => {
    patchResponses.push(
      jsonResponse({ id: "req-1", execution: { executed: true, followUpFailed: false } }),
    );
    render(<BookingChangeRequestsPanel />);
    await writeMemberNote();
    fireEvent.change(screen.getByLabelText(/If the change lowers the price/i), {
      target: { value: "credit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve and apply" }));

    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]).toEqual({
      status: "APPROVED",
      adminNotes: "We have added your niece to the stay.",
      expectedVersion: 4,
      settlementMethod: "credit",
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringMatching(/approved and applied to the booking/i),
      ),
    );
  });

  it("warns about an over-capacity night and applies only once the officer confirms", async () => {
    patchResponses.push(
      jsonResponse(
        {
          id: "req-1",
          status: "REQUESTED",
          keptPending: true,
          needsCapacityConfirmation: true,
          code: "OVER_CAPACITY_CONFIRM_REQUIRED",
          nightDetails: [{ date: "2026-06-11", availableBeds: -1 }],
          error: "Some of this stay's nights are over the lodge's capacity.",
        },
        409,
      ),
      jsonResponse({ id: "req-1", execution: { executed: true } }),
    );
    render(<BookingChangeRequestsPanel />);
    await writeMemberNote();
    fireEvent.click(screen.getByRole("button", { name: "Approve and apply" }));

    const confirm = await screen.findByRole("button", { name: /Confirm overbooking and apply/i });
    expect(screen.getByRole("alert")).toHaveTextContent(/over capacity/i);
    expect(patchBodies()[0]).not.toHaveProperty("confirmOverCapacity");

    fireEvent.click(confirm);
    await waitFor(() => expect(patchBodies()).toHaveLength(2));
    expect(patchBodies()[1]).toMatchObject({ status: "APPROVED", confirmOverCapacity: true });
  });

  it("tells the officer when the change applied but follow-up work did not", async () => {
    patchResponses.push(
      jsonResponse({ id: "req-1", execution: { executed: true, followUpFailed: true } }),
    );
    render(<BookingChangeRequestsPanel />);
    await writeMemberNote();
    fireEvent.click(screen.getByRole("button", { name: "Approve and apply" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/did not complete/i)),
    );
  });

  it("keeps the acknowledgement wording for a stay that has not finished", async () => {
    rows = [changeRequest({ executesOnApproval: false })];
    render(<BookingChangeRequestsPanel />);
    expect(
      await screen.findByRole("button", { name: /Acknowledge as approved/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Linked booking modification id/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/If the change lowers the price/i)).toBeNull();
  });

  it("does not point an approved, unlinked finished-stay request at the booking page", async () => {
    rows = [changeRequest({ status: "APPROVED", reviewedAt: "2026-06-20T10:00:00.000Z" })];
    render(<BookingChangeRequestsPanel />);
    expect(await screen.findByText(/cannot apply it/i)).toBeInTheDocument();
    expect(screen.queryByText(/apply it from the booking page/i)).toBeNull();
  });
});
