// @vitest-environment jsdom

import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it, vi } from "vitest";

// #1940: the panel reads the session permission matrix for view-only gating of
// its retry/replay controls; provide an edit-level admin session so the render
// case is unchanged.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

import { XeroRecordActivityPanel } from "@/components/admin/xero-record-activity-panel";
import type { XeroRecordActivityData } from "@/lib/xero-record-types";

function makeActivityData(): XeroRecordActivityData {
  return {
    rootRecord: {
      localModel: "Payment",
      localId: "pay_1",
      label: "Payment $50.00",
      relation: "Payment",
      url: "/admin/xero/records/Payment/pay_1",
    },
    scopeRecords: [],
    relatedRecords: [],
    summary: {
      totalOperations: 5,
      failedOperations: 1,
      pendingOperations: 1,
      partialOperations: 2,
      activeLinks: 1,
    },
    operations: [],
    links: [],
    inboundEvents: [],
    backLink: null,
  };
}

describe("XeroRecordActivityPanel", () => {
  it("renders partial operation summary counts", () => {
    render(
      <XeroRecordActivityPanel
        localModel="Payment"
        localId="pay_1"
        initialData={makeActivityData()}
      />
    );

    expect(screen.getByText("Partial")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });
});
