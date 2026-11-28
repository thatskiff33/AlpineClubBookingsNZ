// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectSoundOutline } from "@/lib/__tests__/support/heading-outline";
import type { XeroRecordActivityData } from "@/lib/xero-record-types";

/**
 * A Xero record's activity page, its heading outline (#5216, `INV-PUB-006`):
 * the server page's own h1 (the record's label) and the real activity panel's
 * four cards at level 2 under it.
 */

const access = vi.hoisted(() => ({ finance: "edit" as "edit" | "view" }));
const activity = vi.hoisted(() => ({ data: null as unknown }));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "admin-1", adminPermissionMatrix: { finance: access.finance } } },
    status: "authenticated",
  }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/finance/xero/records/Payment/pay_1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/club-format-server", async () => {
  const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
  return { clubFormatValues: async () => CLUB_FORMAT_TEST };
});
vi.mock("@/lib/xero-record-activity", () => ({
  getXeroRecordActivity: async () => activity.data,
}));

import XeroRecordActivityPage from "@/app/(admin)/admin/finance/xero/records/[localModel]/[localId]/page";

function activityData(overrides: Partial<XeroRecordActivityData> = {}): XeroRecordActivityData {
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
    summary: { totalOperations: 0, failedOperations: 0, pendingOperations: 0, partialOperations: 0, activeLinks: 0 },
    operations: [],
    links: [],
    inboundEvents: [],
    backLink: null,
    ...overrides,
  };
}

async function renderPage(data: XeroRecordActivityData) {
  activity.data = data;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(data)));
  render(
    await XeroRecordActivityPage({
      params: Promise.resolve({ localModel: "Payment", localId: "pay_1" }),
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  access.finance = "edit";
});

describe("/admin/finance/xero/records/… heading outline (#5216)", () => {
  it.each([
    ["an officer who can edit", "edit"],
    ["a view-only officer", "view"],
  ] as const)("loaded, with nothing recorded yet, for %s", async (_who, finance) => {
    access.finance = finance;
    await renderPage(activityData());
    expectSoundOutline("Payment $50.00");
    for (const card of ["Record-Scoped Xero Activity", "Xero Object Links", "Operations", "Inbound Events"]) {
      expect(screen.getByRole("heading", { level: 2, name: card })).toBeInTheDocument();
    }
  });
});
