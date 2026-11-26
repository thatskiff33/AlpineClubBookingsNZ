// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HelpWidgetProvider } from "@/components/help-widget/help-widget-context";
import PaymentsPage from "@/app/(admin)/admin/finance/payments/page";
import SubscriptionsPage from "@/app/(admin)/admin/finance/subscriptions/page";
import { adminHref } from "@/lib/admin-hubs";

/*
  #5295: Payments and Subscriptions keep their filters, sort and page in the
  address. A replace to the address already shown is still a soft navigation,
  which drops the page's <title> until the server streams it back (#5155). So
  each page opened at the address it would write replaces nothing, and paging
  still writes the new address once.
*/

// One router and one search-params instance per address, as Next's are: the
// pages' queries depend on both, so a fresh one per render refires them.
const navigation = vi.hoisted(() => {
  const replace = vi.fn();
  return {
    replace,
    router: { replace, push: () => {}, refresh: () => {} },
    pathname: "/",
    searchParams: new URLSearchParams(),
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => navigation.router,
  useSearchParams: () => navigation.searchParams,
  usePathname: () => navigation.pathname,
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
  useAdminAreaViewAccess: () => true,
}));
vi.mock("@/hooks/use-xero-status", () => ({ useXeroStatus: () => ({ connected: true }) }));
vi.mock("@/hooks/use-xero-org-short-code", () => ({
  useXeroOrgShortCode: () => ({ shortCode: null }),
}));
vi.mock("@/lib/admin-xero-contact-groups", () => ({
  loadAdminXeroContactGroups: async () => ({ groups: [] }),
}));
vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({ confirm: async () => true, confirmDialog: null }),
}));
vi.mock("@/components/admin/manual-refund-task-queue", () => ({
  ManualRefundTaskQueue: () => null,
}));
vi.mock("@/app/(admin)/admin/finance/subscriptions/_components/subscription-billing-panel", () => ({
  SubscriptionBillingPanel: () => null,
}));

/** Sixty rows in all, so each list has a second page; no rows are drawn. */
function stubLists() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const page = Number(new URL(input, "http://localhost").searchParams.get("page") ?? 1);
      return Response.json({
        data: [],
        total: 60,
        page,
        pageSize: 25,
        summary: {
          netCollectedCents: 0,
          refundedCents: 0,
          count: 60,
          total: 60,
          paid: 0,
          unpaid: 0,
          overdue: 0,
          notInvoiced: 0,
          notRequired: 0,
        },
      });
    }),
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(() => {
  navigation.replace.mockClear();
  navigation.pathname = "/";
  navigation.searchParams = new URLSearchParams();
  stubLists();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("finance lists replace the address only when it changes (#5295)", () => {
  const cases: Array<[string, string, () => ReactElement]> = [
    [
      "Payments",
      adminHref("payments"),
      () => (
        <HelpWidgetProvider>
          <PaymentsPage />
        </HelpWidgetProvider>
      ),
    ],
    ["Subscriptions", adminHref("subscriptions"), () => <SubscriptionsPage />],
  ];

  it.each(cases)("%s: no replace when opened at its own address, one after paging", async (_name, href, page) => {
    // The address the page writes, learned from a render at another path: both
    // pages write their default window or season, so it is never bare.
    const elsewhere = render(page());
    await waitFor(() => expect(navigation.replace).toHaveBeenCalled());
    const own = new URL(navigation.replace.mock.calls.at(-1)![0] as string, "http://localhost");
    expect(own.pathname).toBe(href);
    elsewhere.unmount();
    navigation.replace.mockClear();

    navigation.pathname = own.pathname;
    navigation.searchParams = new URLSearchParams(own.search);
    render(page());
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Next page" })[0]).toBeEnabled());
    await settle();
    expect(navigation.replace).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "Next page" })[0]);
    await waitFor(() => expect(navigation.replace).toHaveBeenCalled());
    await settle();
    expect(navigation.replace).toHaveBeenCalledTimes(1);
    const paged = new URL(navigation.replace.mock.calls[0][0] as string, "http://localhost");
    expect(paged.pathname).toBe(href);
    expect(paged.searchParams.get("page")).toBe("2");
  });
});
