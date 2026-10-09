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
let quoteResponses: Response[];
let fetchMock: ReturnType<typeof vi.fn>;

const QUOTE = {
  priceDiffCents: 9_000,
  changeFeeCents: 0,
  additionalAmountCents: 9_000,
  refundAmountCents: 0,
  accountCreditAmountCents: 0,
  capacityOverridden: false,
  settlementMethod: "card",
};

beforeEach(() => {
  vi.clearAllMocks();
  rows = [changeRequest()];
  patchResponses = [];
  quoteResponses = [];
  fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/quote")) {
      return quoteResponses.shift() ?? jsonResponse({ id: "req-1", quote: QUOTE });
    }
    if (init?.method === "PATCH") {
      return patchResponses.shift() ?? jsonResponse({ id: "req-1" });
    }
    if (url.includes("/api/admin/booking-change-requests")) {
      return jsonResponse({ data: rows, page: 1, pageSize: 25, total: rows.length });
    }
    return jsonResponse({});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function bodiesTo(suffix: string, method: string): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        String(input).endsWith(suffix) && (init as RequestInit | undefined)?.method === method,
    )
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}
const patchBodies = () => bodiesTo("req-1", "PATCH");
const quoteBodies = () => bodiesTo("/quote", "POST");

async function writeMemberNote() {
  fireEvent.change(await screen.findByLabelText(/Explanation for the member/i), {
    target: { value: "We have added your niece to the stay." },
  });
}

async function checkFigures() {
  fireEvent.click(screen.getByRole("button", { name: /Check the figures|Check again/i }));
  await screen.findByRole("list", { name: /What approving will do/i });
}

describe("change-request panel on a finished stay (#3750)", () => {
  it("says approving applies the change, and never sends the officer to the booking page", async () => {
    render(<BookingChangeRequestsPanel />);
    expect(await screen.findByRole("button", { name: "Approve and apply" })).toBeInTheDocument();
    expect(screen.getByText(/approving applies the request to the booking/i)).toBeInTheDocument();
    expect(screen.queryByText(/apply the change there/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Acknowledge as approved/i })).toBeNull();
    expect(screen.queryByLabelText(/Linked booking modification id/i)).toBeNull();
    expect(screen.getByLabelText(/If the change lowers the price/i)).toHaveValue("");
  });

  it("shows the figures before approving, and keeps Approve off until they are on screen (P2)", async () => {
    patchResponses.push(jsonResponse({ id: "req-1", execution: { executed: true, followUpFailed: false } }));
    render(<BookingChangeRequestsPanel />);
    await writeMemberNote();
    const approve = screen.getByRole("button", { name: "Approve and apply" });
    expect(approve).toBeDisabled();

    await checkFigures();
    expect(screen.getByText(/The member will be asked for/i)).toBeInTheDocument();
    expect(approve).not.toBeDisabled();
    // The default refund arm is the server's — the way the booking was paid.
    expect(quoteBodies()[0]).toEqual({});

    fireEvent.click(approve);
    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]).toEqual({
      status: "APPROVED",
      execute: true,
      adminNotes: "We have added your niece to the stay.",
      expectedVersion: 4,
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/approved and applied to the booking/i)),
    );
  });

  it("a changed refund choice needs fresh figures, and is sent with the approval", async () => {
    render(<BookingChangeRequestsPanel />);
    await writeMemberNote();
    await checkFigures();
    fireEvent.change(screen.getByLabelText(/If the change lowers the price/i), {
      target: { value: "credit" },
    });
    const approve = screen.getByRole("button", { name: "Approve and apply" });
    expect(approve).toBeDisabled();
    await checkFigures();
    expect(quoteBodies()[1]).toEqual({ settlementMethod: "credit" });
    fireEvent.click(approve);
    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]).toMatchObject({ execute: true, settlementMethod: "credit" });
  });

  it("warns about an over-capacity night, and quotes and applies with the confirmation", async () => {
    quoteResponses.push(
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
    );
    render(<BookingChangeRequestsPanel />);
    await writeMemberNote();
    fireEvent.click(screen.getByRole("button", { name: /Check the figures/i }));
    const confirm = await screen.findByRole("button", { name: /Confirm overbooking/i });
    expect(screen.getByRole("alert")).toHaveTextContent(/over capacity/i);

    fireEvent.click(confirm);
    await screen.findByRole("list", { name: /What approving will do/i });
    expect(quoteBodies()[1]).toEqual({ confirmOverCapacity: true });
    fireEvent.click(screen.getByRole("button", { name: "Approve and apply" }));
    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]).toMatchObject({ execute: true, confirmOverCapacity: true });
  });

  it("tells the officer when the change applied but follow-up work did not", async () => {
    patchResponses.push(jsonResponse({ id: "req-1", execution: { executed: true, followUpFailed: true } }));
    render(<BookingChangeRequestsPanel />);
    await writeMemberNote();
    await checkFigures();
    fireEvent.click(screen.getByRole("button", { name: "Approve and apply" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/did not complete/i)),
    );
  });

  it("shows a member among the added guests, with a link (owner D1)", async () => {
    rows = [
      changeRequest({
        requestedChanges: {
          requested: {
            summary: "add Sam Member",
            addGuests: [{ firstName: "Sam", lastName: "Member", memberId: "m-9" }],
          },
        },
      }),
    ];
    render(<BookingChangeRequestsPanel />);
    const link = await screen.findByRole("link", { name: "open member" });
    expect(link.getAttribute("href")).toContain("/admin/members/m-9");
    expect(screen.getByText(/member guest rules and any consent step apply/i)).toBeInTheDocument();
  });

  it("keeps the acknowledgement wording, and says so in its intent, for a stay that has not finished", async () => {
    rows = [changeRequest({ executesOnApproval: false })];
    render(<BookingChangeRequestsPanel />);
    const ack = await screen.findByRole("button", { name: /Acknowledge as approved/i });
    expect(screen.getByLabelText(/Linked booking modification id/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/If the change lowers the price/i)).toBeNull();
    await writeMemberNote();
    fireEvent.click(ack);
    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]).toMatchObject({ status: "APPROVED", execute: false });
  });

  it("does not point an approved, unlinked finished-stay request at the booking page", async () => {
    rows = [changeRequest({ status: "APPROVED", reviewedAt: "2026-06-20T10:00:00.000Z" })];
    render(<BookingChangeRequestsPanel />);
    expect(await screen.findByText(/cannot apply it/i)).toBeInTheDocument();
    expect(screen.queryByText(/apply it from the booking page/i)).toBeNull();
  });
});
