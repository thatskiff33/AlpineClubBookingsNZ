// @vitest-environment jsdom
//
// #2569 — the officer queue has to say whether the adult-member rule REFUSED the
// booking or merely FLAGGED it.
//
// The reason label is "Adult member must host" either way, and the two are opposite
// situations. Under the review consequence the booking exists and the officer is
// recording a view of it; under the enforcing consequence there is no booking at all
// until they approve, and a member is waiting for a bed. Nothing else on the card
// distinguishes them — the status, the age, the rule list and the nights are
// identical — so an officer reading the wrong one deprioritises the only queue item
// that is actually blocking somebody.
//
// Read off the FROZEN violation, never the live policy row: the club may have changed
// the setting since, and what the officer decides is what happened at the time.

import { cleanup, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => true,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PolicyExceptionRequestsPanel } from "../policy-exception-requests-panel";

const HOSTING_REF = {
  reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
  policyId: "policy-1",
  policyVersion: 3,
  capacityMode: "NO_HOLD",
};

function queueItem(overrides: Record<string, unknown>) {
  return {
    source: "NEW_BOOKING",
    id: "req-1",
    status: "REQUESTED",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    version: 1,
    bookingId: null,
    lodgeId: "lodge-1",
    requestedBy: {
      id: "member-1",
      firstName: "Ana",
      lastName: "Ngata",
      email: "ana@example.test",
    },
    reviewedBy: null,
    reviewedAt: null,
    memberMessage: null,
    proposalHash: "hash",
    aggregateCapacityMode: "NO_HOLD",
    reasonCodes: ["ADULT_MEMBER_HOSTING_REQUIRED"],
    policyRefs: [HOSTING_REF],
    hostingConsequence: null,
    affectedNights: ["2026-08-14"],
    proposedCheckIn: "2026-08-14",
    proposedCheckOut: "2026-08-15",
    proposedGuestCount: 3,
    adminNotes: null,
    createdBookingId: null,
    attemptCount: 1,
    conflictCount: 0,
    lastConflictAt: null,
    lastConflictReason: null,
    supersededByRequestId: null,
    summary: null,
    ...overrides,
  };
}

async function renderQueue(items: Array<Record<string, unknown>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({ data: items, page: 1, pageSize: 100, total: items.length }),
        { status: 200 },
      ),
    ),
  );
  render(<PolicyExceptionRequestsPanel />);
  await waitFor(() => expect(screen.getByText("Ana Ngata")).toBeTruthy());
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the officer queue distinguishes a hosting refusal from a hosting review (#2569)", () => {
  it("says the booking does not exist yet when the rule REFUSED a new booking", async () => {
    await renderQueue([queueItem({ hostingConsequence: "ENFORCED" })]);
    expect(
      screen.getByText(/refused this booking, so it does not exist yet/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Approving the exception is what allows it to be made/i),
    ).toBeTruthy();
    // And it must NOT read as the review case, which would tell the officer a
    // booking is already made.
    expect(screen.queryByText(/asked for a look/i)).toBeNull();
  });

  it("says the booking still stands when the rule REFUSED a change", async () => {
    await renderQueue([
      queueItem({
        source: "MODIFICATION",
        hostingConsequence: "ENFORCED",
        bookingId: "booking-9",
      }),
    ]);
    expect(
      screen.getByText(/refused this change, so the booking still stands/i),
    ).toBeTruthy();
  });

  it("says the booking already exists when the rule only FLAGGED it", async () => {
    await renderQueue([
      queueItem({ hostingConsequence: "ADMIN_REVIEW_REQUIRED" }),
    ]);
    expect(
      screen.getByText(/allowed the booking and asked for a look/i),
    ).toBeTruthy();
    expect(screen.queryByText(/refused/i)).toBeNull();
  });

  it("says nothing at all when the request carries no hosting reason", async () => {
    // A minimum-stay or paid-up-adult request must not acquire a sentence about a
    // rule it never tripped, and a snapshot frozen before #2569 has no consequence
    // to report — both arrive here as null.
    await renderQueue([
      queueItem({
        reasonCodes: ["MINIMUM_STAY"],
        policyRefs: [{ ...HOSTING_REF, reasonCode: "MINIMUM_STAY" }],
        hostingConsequence: null,
      }),
    ]);
    expect(screen.getByText(/Minimum stay/)).toBeTruthy();
    expect(screen.queryByText(/adult-member rule/i)).toBeNull();
  });

  it("does not restate the bed hold, which the header badge already reports", async () => {
    // Two derivations of the same fact drift. The badge reads the source and the
    // aggregate capacity mode; this sentence deliberately says nothing about beds.
    await renderQueue([queueItem({ hostingConsequence: "ENFORCED" })]);
    const sentence = screen.getByText(/refused this booking/i).textContent ?? "";
    expect(sentence).not.toMatch(/bed/i);
    expect(screen.getByText("No beds held")).toBeTruthy();
  });
});
