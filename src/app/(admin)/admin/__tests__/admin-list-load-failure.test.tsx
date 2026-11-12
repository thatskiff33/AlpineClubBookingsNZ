// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One URLSearchParams per test file, as Next keeps it stable between renders.
const navigation = vi.hoisted(() => ({ replace: vi.fn(), searchParams: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  useSearchParams: () => navigation.searchParams,
  usePathname: () => "/admin",
}));
vi.mock("@/hooks/use-admin-area-edit-access", async (original) => ({
  ...(await original()) as typeof import("@/hooks/use-admin-area-edit-access"),
  useAdminAreaEditAccess: () => true,
}));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "admin", accessRoles: [{ role: "ADMIN" }] } } }) }));
vi.mock("@/hooks/use-xero-status", () => ({ useXeroStatus: () => ({ connected: false }) }));
vi.mock("@/hooks/use-xero-org-short-code", () => ({ useXeroOrgShortCode: () => ({ shortCode: null }) }));
vi.mock("@/components/admin/manual-refund-task-queue", () => ({ ManualRefundTaskQueue: () => null }));
vi.mock("@/app/(admin)/admin/finance/subscriptions/_components/subscription-billing-panel", () => ({ SubscriptionBillingPanel: () => null }));
vi.mock("@/components/club-identity-provider", () => ({ useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }) }));
vi.mock("@/app/(admin)/admin/hut-leaders/_components/assignment-form", () => ({
  // The real form's conflict preview reads the page's assignments, so stale
  // rows would warn about a clash with an assignment nobody can see.
  AssignmentForm: ({ onVisibleMonthChange, onPickNights, onSelectAnyMember, summary }: {
    onVisibleMonthChange: (month: string) => void;
    onPickNights: (range: { startDate: string; endDate: string }) => void;
    onSelectAnyMember: (member: { id: string; firstName: string; lastName: string }) => void;
    summary: { conflicts: Array<{ name: string }> } | null;
  }) => <>
    <button onClick={() => onVisibleMonthChange("2026-08")}>Next calendar month</button>
    <button onClick={() => onPickNights({ startDate: "2026-07-09", endDate: "2026-07-12" })}>Pick nights</button>
    <button onClick={() => onSelectAnyMember({ id: "new", firstName: "New", lastName: "Leader" })}>Pick member</button>
    {summary?.conflicts.map((conflict) => <p key={conflict.name}>Clashes with {conflict.name}</p>)}
  </>,
}));
// Keep page query state real; only replace Radix's portal/selection machinery.
vi.mock("@/components/ui/select", async () => {
  const { createContext, useContext } = await import("react");
  const Context = createContext<{ value: string; onValueChange: (value: string) => void }>({ value: "", onValueChange: () => {} });
  return {
    Select: ({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: ReactNode }) =>
      <Context.Provider value={{ value, onValueChange }}>{children}</Context.Provider>,
    SelectTrigger: ({ id }: { id?: string }) => {
      const { value, onValueChange } = useContext(Context);
      return <input id={id} value={value} onChange={(event) => onValueChange(event.target.value)} />;
    },
    SelectValue: () => null,
    SelectContent: () => null,
    SelectItem: () => null,
  };
});

import PaymentsPage from "@/app/(admin)/admin/finance/payments/page";
import SubscriptionsPage from "@/app/(admin)/admin/finance/subscriptions/page";
import HutLeadersPage from "@/app/(admin)/admin/hut-leaders/page";
import CommunicationsPage from "@/app/(admin)/admin/messages/communications/page";

const payment = {
  id: "payment", amountCents: 12345, refundedAmountCents: 0, status: "SUCCEEDED",
  source: "STRIPE", createdAt: "2026-06-30T00:00:00Z", lastUpdatedAt: "2026-06-30T00:00:00Z",
  xeroState: "notNeeded", settlementState: "settled", stripePaymentIntentId: null,
  xeroActivity: { failed: 0, partial: 0, pending: 0, latestOperationId: null, latestOperationStatus: null, latestOperationAt: null },
  booking: { id: "booking", reference: "STALE-PAYMENT", status: "CONFIRMED", checkIn: "2026-07-10", checkOut: "2026-07-12", creditsFromCancellation: [], member: { id: "member", firstName: "Previous", lastName: "Payment", email: "previous@example.test" } },
};
const subscription = {
  id: "subscription", memberId: "member", seasonYear: 2026, status: "PAID", paidAt: null,
  manuallyMarkedPaidAt: null, xeroContactGroups: [], xeroContactGroupsLoaded: true,
  member: { firstName: "Previous", lastName: "Subscriber", email: "subscriber@example.test", ageTier: "ADULT", canLogin: true, hasCompletedAccountSetup: true, pendingInviteExpiresAt: null, xeroContactId: null },
};
const assignment = {
  id: "assignment", memberId: "member", memberName: "Previous Leader", memberEmail: "leader@example.test",
  startDate: "2026-07-10", endDate: "2026-07-12", createdAt: "2026-06-01T00:00:00Z",
  lodgeId: "lodge-1", lodgeName: "Lodge One", bedId: null, bedName: null, bedRoomName: null,
};
const history = { id: "history", subject: "Previous newsletter", sentAt: "2026-06-30T00:00:00Z", recipientFilter: "all", totalRecipients: 1, eligibleRecipients: 1, queued: 1, sentBy: "Admin" };

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
type Failure = "server" | "network";
let failure: Failure | null;
let failUnassigned = false;
let failAssignments = true;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const fail = () => {
    if (failure === "network") throw new TypeError("Failed to fetch");
    return response({ error: "The list service is unavailable." }, 500);
  };
  if (init?.method && init.method !== "GET") return response({ eligibleRecipients: 1, filteredByPreference: 0 });
  if (url.startsWith("/api/admin/payments?")) return failure ? fail() : response({ data: [payment], total: 60, summary: { netCollectedCents: 12345, refundedCents: 200, count: 1 } });
  if (url.startsWith("/api/admin/subscriptions?")) return failure ? fail() : response({ data: [subscription], total: 60, summary: { total: 17, paid: 13, unpaid: 4, overdue: 2, notInvoiced: 0, notRequired: 0 } });
  if (url === "/api/admin/communications/history") return failure ? fail() : response({ history: [history] });
  if (url === "/api/admin/communications/send") return response({ limit: 10 });
  if (url === "/api/admin/lodges") return response({ lodges: [{ id: "lodge-1", name: "Lodge One" }, { id: "lodge-2", name: "Lodge Two" }] });
  if (url.startsWith("/api/admin/hut-leaders/unassigned-dates?")) return failure && failUnassigned ? fail() : response({ unassignedDates: [{ date: "2026-07-10", bookingCount: 1, guestCount: 3 }] });
  if (url.startsWith("/api/admin/hut-leaders?")) return failure && failAssignments ? fail() : response({ assignments: [assignment] });
  if (url.startsWith("/api/admin/occupancy?")) return response({ nights: [] });
  if (url.startsWith("/api/admin/hut-leaders/eligible-members?")) return response({ members: [] });
  if (url === "/api/admin/age-tiers") return response({ ageTiers: [] });
  throw new Error(`Unexpected test request: ${url}`);
});

beforeEach(() => {
  failure = null;
  failUnassigned = false;
  failAssignments = true;
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", () => true);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function assertFailure(testId: string, empty: string | RegExp, stale: string) {
  const alert = await screen.findByTestId(testId);
  expect(alert).toHaveAttribute("role", "alert");
  expect(alert).toHaveTextContent(failure === "network" ? "Check your connection" : "The list service is unavailable.");
  expect(screen.queryByText(empty)).not.toBeInTheDocument();
  expect(screen.queryByText(stale)).not.toBeInTheDocument();
  expect(within(alert).getByRole("button", { name: "Try again" })).toBeEnabled();
  return alert;
}

for (const kind of ["server", "network"] as const) {
  describe(`${kind} failure`, () => {
    it("Payments clears the previous search's rows and totals and recovers", async () => {
      render(<PaymentsPage />);
      await screen.findByText("Payment, Previous");
      expect(screen.getAllByText("$123.45").length).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: "Next page" })).toBeInTheDocument();
      failure = kind;
      fireEvent.change(screen.getByLabelText("Member or reference"), { target: { value: "new query" } });
      const alert = await assertFailure("payments-load-error", "No payments found", "Payment, Previous");
      expect(screen.queryByText("$123.45")).not.toBeInTheDocument();
      expect(screen.queryByText("Net Collected")).not.toBeInTheDocument();
      expect(screen.queryByText(/Showing .*payment/)).not.toBeInTheDocument();
      // The previous query's total must not survive as page controls.
      expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /More filters/ })).toHaveAttribute("aria-expanded", "false");
      failure = null;
      fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
      await screen.findByText("Payment, Previous");
      expect(screen.queryByTestId("payments-load-error")).not.toBeInTheDocument();
    });

    it("Subscriptions clears the previous season's rows and counts and recovers", async () => {
      render(<SubscriptionsPage />);
      await screen.findByText("Subscriber, Previous");
      expect(screen.getByText("17")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next page" })).toBeInTheDocument();
      failure = kind;
      fireEvent.change(screen.getByLabelText("Season Year"), { target: { value: "2027" } });
      const alert = await assertFailure("subscriptions-load-error", "No subscriptions found", "Subscriber, Previous");
      expect(screen.queryByText("17")).not.toBeInTheDocument();
      expect(screen.queryByText(/Showing .*subscription/)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
      failure = null;
      fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
      await screen.findByText("Subscriber, Previous");
      expect(screen.queryByTestId("subscriptions-load-error")).not.toBeInTheDocument();
    });

    it("Hut Leaders clears assignments when a calendar reload fails and recovers", async () => {
      render(<HutLeadersPage />);
      await screen.findByText("Previous Leader");
      fireEvent.click(screen.getByRole("button", { name: "Pick nights" }));
      fireEvent.click(screen.getByRole("button", { name: "Pick member" }));
      expect(screen.getByText("Clashes with Previous Leader")).toBeInTheDocument();
      failure = kind;
      fireEvent.click(screen.getByRole("button", { name: "Next calendar month" }));
      const alert = await assertFailure("hut-leaders-assignments-load-error", /No hut leader assignments yet/, "Previous Leader");
      expect(screen.queryByText("Clashes with Previous Leader")).not.toBeInTheDocument();
      failure = null;
      fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
      await screen.findByText("Previous Leader");
      expect(screen.queryByTestId("hut-leaders-assignments-load-error")).not.toBeInTheDocument();
    });

    it("Hut Leaders reports a failed coverage check after a successful delete", async () => {
      render(<HutLeadersPage />);
      await screen.findByText("Previous Leader");
      await screen.findByText(/3 guests/);
      failAssignments = false;
      failUnassigned = true;
      failure = kind;
      fireEvent.click(screen.getByRole("button", { name: /Delete assignment/i }));
      const alert = await assertFailure("hut-leaders-unassigned-load-error", /No hut leader assignments yet/, "3 guests");
      expect(alert).toHaveTextContent("could not be checked");
      failure = null;
      fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
      await screen.findByText(/3 guests/);
      expect(screen.queryByTestId("hut-leaders-unassigned-load-error")).not.toBeInTheDocument();
    });

    it("Communications clears previous history after a successful send's reload fails", async () => {
      render(<CommunicationsPage />);
      await screen.findByText("Previous newsletter");
      failure = kind;
      fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "New newsletter" } });
      fireEvent.change(screen.getByLabelText("Message Body"), { target: { value: "Club news" } });
      fireEvent.click(screen.getByRole("button", { name: /Send to members/i }));
      const alert = await assertFailure("communications-history-load-error", "No bulk communications sent yet.", "Previous newsletter");
      expect(screen.getByText(/Sent to 1 recipients/)).toBeInTheDocument();
      failure = null;
      fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
      await screen.findByText("Previous newsletter");
      expect(screen.queryByTestId("communications-history-load-error")).not.toBeInTheDocument();
    });
  });
}

it("Payments shows a 400 pointer while More filters is closed and keeps the field reason", async () => {
  fetchMock.mockImplementationOnce(async () => response({ error: "Invalid query parameters", details: { formErrors: [], fieldErrors: { search: ["Search must be at most 100 characters."] } } }, 400));
  render(<PaymentsPage />);
  const alert = await screen.findByTestId("payments-load-error");
  expect(alert).toHaveTextContent("Search must be at most 100 characters.");
  expect(alert).toHaveTextContent("Check the filters");
  expect(screen.queryByText("No payments found")).not.toBeInTheDocument();
  expect(screen.queryByTestId("payments-filter-error")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /More filters/ }));
  expect(screen.getByTestId("payments-filter-error")).toHaveTextContent("Search must be at most 100 characters.");
});

it("ignores late failures from the previous lodge for both reads", async () => {
  let rejectAssignments!: (reason: Error) => void;
  let rejectCoverage!: (reason: Error) => void;
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/admin/hut-leaders?lodgeId=lodge-1") return new Promise<Response>((_resolve, reject) => { rejectAssignments = reject; });
    if (url === "/api/admin/hut-leaders/unassigned-dates?lodgeId=lodge-1") return new Promise<Response>((_resolve, reject) => { rejectCoverage = reject; });
    return original(input, init);
  });
  try {
    render(<HutLeadersPage />);
    await waitFor(() => expect(rejectCoverage).toBeTypeOf("function"));
    fireEvent.change(screen.getByLabelText("Lodge"), { target: { value: "lodge-2" } });
    await screen.findByText("Previous Leader");
    await act(async () => { rejectAssignments(new Error("offline")); rejectCoverage(new Error("offline")); });
    expect(screen.queryByTestId("hut-leaders-assignments-load-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("hut-leaders-unassigned-load-error")).not.toBeInTheDocument();
    expect(screen.getByText("Previous Leader")).toBeInTheDocument();
  } finally { fetchMock.mockImplementation(original); }
});
