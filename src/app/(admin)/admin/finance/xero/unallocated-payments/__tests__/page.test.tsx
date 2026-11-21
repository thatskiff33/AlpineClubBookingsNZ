// @vitest-environment jsdom

/**
 * #5204: the Xero Unallocated Payments queue. Each open document shows its
 * balance and member (or that none is linked); Refresh is a finance-edit
 * action whose failure takes focus and leaves the list as it was.
 */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ finance: "edit" as "edit" | "view" }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "admin-1", adminPermissionMatrix: { finance: session.finance } } } }),
}));

import XeroUnallocatedPaymentsPage from "@/app/(admin)/admin/finance/xero/unallocated-payments/page";

const QUEUE = {
  refreshedAt: "2026-06-30T14:00:00.000Z",
  rows: [
    { id: "a", kind: "OVERPAYMENT", xeroDocumentId: "op-1", xeroContactId: "contact-1", currencyCode: "NZD", documentDate: "2026-06-20", totalCents: 20_000, remainingCents: 12_345, member: { id: "member-1", name: "Cash Credit" } },
    { id: "b", kind: "PREPAYMENT", xeroDocumentId: "pp-1", xeroContactId: "contact-2", currencyCode: "AUD", documentDate: null, totalCents: 5_000, remainingCents: 5_000, member: null },
  ],
};

const fetchMock = vi.fn();
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => {
  session.finance = "edit";
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/admin/xero/organisation") return json(200, { shortCode: "!abc" });
    if (url === "/api/admin/xero/cash-credits" && !init?.method) return json(200, QUEUE);
    throw new Error(`unexpected fetch ${url}`);
  });
  global.fetch = fetchMock as typeof fetch;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe("XeroUnallocatedPaymentsPage", () => {
  it("lists each document's balance and member, or that no member is linked", async () => {
    render(<XeroUnallocatedPaymentsPage />);
    const rows = await screen.findAllByRole("row");
    const [, first, second] = rows;
    expect(within(first!).getByText("Overpayment")).toBeInTheDocument();
    expect(within(first!).getByText(/123\.45/)).toBeInTheDocument();
    expect(within(first!).getByText(/of .*200\.00/)).toBeInTheDocument();
    expect(within(first!).getByRole("link", { name: "Cash Credit" })).toHaveAttribute("href", expect.stringContaining("member-1"));
    expect(within(second!).getByText("Prepayment")).toBeInTheDocument();
    expect(within(second!).getByText("No member linked")).toBeInTheDocument();
    expect(within(second!).getByText("No date")).toBeInTheDocument();
    expect(within(first!).queryByText(/^in /)).not.toBeInTheDocument();
    expect(within(second!).getByText("in AUD")).toBeInTheDocument();
    expect(within(second!).queryByText(/^of /)).not.toBeInTheDocument();
    expect(within(second!).getByRole("link", { name: "Open contact in Xero" })).toHaveAttribute("href", expect.stringContaining("contact-2"));
  });

  it("disables Refresh for a finance view-only officer", async () => {
    session.finance = "view";
    render(<XeroUnallocatedPaymentsPage />);
    await screen.findByText("Cash Credit");
    expect(screen.getByRole("button", { name: /Refresh from Xero/ })).toBeDisabled();
  });

  it("shows a failed Refresh in a focused alert and keeps the list", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/xero/organisation") return json(200, { shortCode: null });
      if (init?.method === "POST") return json(502, { error: "Xero returned an overpayment the app cannot read (x); nothing was refreshed." });
      return json(200, QUEUE);
    });
    render(<XeroUnallocatedPaymentsPage />);
    await screen.findByText("Cash Credit");
    fireEvent.click(screen.getByRole("button", { name: /Refresh from Xero/ }));
    const alert = await screen.findByText("Xero returned an overpayment the app cannot read (x); nothing was refreshed.");
    await waitFor(() => expect(document.activeElement).toBe(alert.closest("[tabindex]")));
    expect(screen.getByText("Cash Credit")).toBeInTheDocument();
  });

  it("replaces the list with the refreshed one", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/xero/organisation") return json(200, { shortCode: null });
      if (init?.method === "POST") return json(200, { result: { open: 0, written: 0, zeroed: 2, current: true }, queue: { refreshedAt: "2026-07-01T00:00:00.000Z", rows: [] } });
      return json(200, QUEUE);
    });
    render(<XeroUnallocatedPaymentsPage />);
    await screen.findByText("Cash Credit");
    fireEvent.click(screen.getByRole("button", { name: /Refresh from Xero/ }));
    expect(await screen.findByText("No unallocated payments")).toBeInTheDocument();
    expect(screen.getByText("Refreshed from Xero.")).toBeInTheDocument();
  });
});
