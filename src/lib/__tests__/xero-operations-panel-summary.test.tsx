// @vitest-environment jsdom

import { fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it, vi } from "vitest";
import { OperationItem } from "@/app/(admin)/admin/xero/_components/operations-panel";
import { resolveDialogDescription } from "@/app/(admin)/admin/xero/_components/resolve-dialog-copy";
import type { XeroOperation } from "@/app/(admin)/admin/xero/_components/types";

function makeOperation(overrides: Partial<XeroOperation> = {}): XeroOperation {
  return {
    id: "op-1",
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: null,
    localId: null,
    localUrl: null,
    status: "SUCCEEDED",
    idempotencyKey: null,
    correlationKey: null,
    attemptCount: 1,
    replayable: false,
    lastErrorCode: null,
    lastErrorMessage: null,
    requestPayload: null,
    responsePayload: null,
    xeroObjectType: null,
    xeroObjectId: null,
    xeroObjectNumber: null,
    xeroObjectUrl: null,
    createdByMemberId: null,
    startedAt: null,
    completedAt: null,
    manuallyResolvedAt: null,
    manuallyResolvedReason: null,
    manuallyResolvedById: null,
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
    supported: false,
    reason: null,
    failureState: null,
    failureStateReason: null,
    failureRootKey: null,
    staleRunning: false,
    resolveAsksCreditNoteNumber: false,
    resolveCreditNoteAmountCents: null,
    resolveRefusal: null,
    ...overrides,
  };
}

const noop = () => {};

function renderItem(
  operation: XeroOperation,
  { canEdit = true, onMarkFailed = noop }: { canEdit?: boolean; onMarkFailed?: () => void } = {},
) {
  return render(
    <OperationItem
      operation={operation}
      canEdit={canEdit}
      retrying={false}
      markingNonReplayable={false}
      resolving={false}
      markingFailed={false}
      onRetry={noop}
      onMarkNonReplayable={noop}
      onResolve={noop}
      onMarkFailed={onMarkFailed}
    />,
  );
}

describe("OperationItem summary + raw toggle", () => {
  it("shows the plain-English summary by default and reveals raw JSON on toggle", () => {
    renderItem(
      makeOperation({
        requestPayload: { queueType: "BOOKING_INVOICE", bookingId: "booking-1" },
      }),
    );

    // Summary is the default view.
    expect(screen.getByText("Queued: create booking invoice")).toBeDefined();
    // Raw JSON is hidden until toggled.
    expect(screen.queryByText("Request")).toBeNull();
    expect(screen.queryByText("Response")).toBeNull();

    fireEvent.click(screen.getByText("Show raw JSON"));

    // Raw request/response blocks are now visible.
    expect(screen.getByText("Request")).toBeDefined();
    expect(screen.getByText("Response")).toBeDefined();
    expect(screen.getByText("Hide raw JSON")).toBeDefined();
  });

  it("keeps the raw-only details view for unmapped operations", () => {
    renderItem(
      makeOperation({
        entityType: "PAYMENT",
        requestPayload: { anything: "unmapped" },
      }),
    );

    expect(screen.getByText("View request / response payloads")).toBeDefined();
    expect(screen.queryByText("Show raw JSON")).toBeNull();
    expect(screen.queryByText("Queued: create booking invoice")).toBeNull();
  });
});

describe("OperationItem failure explanation (#4278)", () => {
  const overAllocation =
    "Credit Note cannot be allocated as the allocation amount is greater than the amount remaining on the Credit Note";

  it("explains a failed row in plain English, with the stored text behind a disclosure", () => {
    const { container } = renderItem(
      makeOperation({ status: "FAILED", entityType: "ALLOCATION", lastErrorCode: "400", lastErrorMessage: overAllocation }),
    );

    expect(screen.getByText(/less credit left than the app expected/)).toBeDefined();
    expect(screen.getByText("What to do:")).toBeDefined();
    expect(container.querySelector("[data-xero-failure-kind='CREDIT_TOO_LOW']")).not.toBeNull();

    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Show technical details");
    expect(details?.textContent).toContain("allocation amount is greater than the amount remaining");
  });

  it("still shows something useful when the stored detail is hidden", () => {
    const { container } = renderItem(
      makeOperation({ status: "FAILED", lastErrorCode: "400", lastErrorMessage: "[REDACTED]" }),
    );
    expect(container.querySelector("[data-xero-failure-kind='DETAIL_HIDDEN']")).not.toBeNull();
  });
});

describe("OperationItem credit-used-outside-the-app chip (#4220)", () => {
  const spent = { status: "FAILED" as const, entityType: "ALLOCATION", lastErrorCode: "CREDIT_NOTE_SPENT_OUTSIDE_APP", lastErrorMessage: "spent in Xero" };

  it("names an Active failure the converge left open and says where the amount is chased", () => {
    renderItem(makeOperation({ ...spent, failureState: "ACTIVE" }));
    expect(screen.getByText("Credit used outside the app")).toBeDefined();
    expect(screen.getByText(/chased from Xero/)).toBeDefined();
  });

  it("is absent for another error code, a repaired row and a resolved row", () => {
    const cases = [
      makeOperation({ ...spent, lastErrorCode: "400", failureState: "ACTIVE" }),
      makeOperation({ ...spent, failureState: "REPAIRED" }),
      makeOperation({ ...spent, failureState: "ACTIVE", manuallyResolvedAt: "2026-06-30T00:00:00.000Z" }),
    ];
    for (const operation of cases) {
      const { unmount } = renderItem(operation);
      expect(screen.queryByText("Credit used outside the app")).toBeNull();
      expect(screen.queryByText(/chased from Xero/)).toBeNull();
      unmount();
    }
  });
});

describe("OperationItem Mark failed (#3462)", () => {
  it("offers Mark failed on a stale running operation and calls it", () => {
    const onMarkFailed = vi.fn();
    renderItem(
      makeOperation({ status: "RUNNING", staleRunning: true }),
      { onMarkFailed },
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark failed" }));
    expect(onMarkFailed).toHaveBeenCalledTimes(1);
  });

  it("offers nothing on a running operation that is not stale", () => {
    renderItem(makeOperation({ status: "RUNNING", staleRunning: false }));
    expect(screen.queryByRole("button", { name: "Mark failed" })).toBeNull();
  });

  it("keeps the button inert for a view-only finance admin", () => {
    const onMarkFailed = vi.fn();
    renderItem(
      makeOperation({ status: "RUNNING", staleRunning: true }),
      { canEdit: false, onMarkFailed },
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark failed" }));
    expect(onMarkFailed).not.toHaveBeenCalled();
  });
});

describe("the resolve dialog's text (#4250, owner decision 21 Oct 2026)", () => {
  it("tells an officer resolving a credit note not to replace a voided card refund note by hand", () => {
    expect(resolveDialogDescription("CREDIT_NOTE")).toContain(
      "If you later void a card refund's credit note in Xero, don't make a replacement by hand: the app raises a fresh one overnight.",
    );
  });

  it("says nothing about credit notes when resolving anything else", () => {
    expect(resolveDialogDescription("INVOICE")).toBe("How was this resolved in Xero? This drops it off the active failure list.");
  });
});
