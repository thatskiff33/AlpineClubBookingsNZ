// @vitest-environment jsdom

import { fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it, vi } from "vitest";
import { OperationItem } from "@/app/(admin)/admin/xero/_components/operations-panel";
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
