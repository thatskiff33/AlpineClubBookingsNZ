// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClubTimeProvider } from "@/components/club-time-provider";

const mocks = vi.hoisted(() => ({
  canEdit: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: mocks.canEdit,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View only",
}));
vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({ confirm: mocks.confirm, confirmDialog: null }),
}));

import { SubscriptionBillingPanel } from "@/app/(admin)/admin/subscriptions/_components/subscription-billing-panel";

/**
 * The club's day under the suite's default provider zone (`Pacific/Auckland`)
 * and the frozen clock (`2026-07-01T00:00:00.000Z`, midday NZ).
 *
 * This suite used to `vi.mock("@/lib/date-only")` to pin the panel's default
 * decision date. CT-4 (#2870) took the panel off that adapter — the default now
 * comes from the club's PERSISTED timezone through `useClubTime` — so the mock
 * was pinning a module the panel no longer reads. It is gone, and the zone the
 * provider supplies is what decides.
 *
 * NOTE THAT THIS CONSTANT PROVES NOTHING ABOUT ZONE AUTHORITY on its own:
 * `Pacific/Auckland` is also what `APP_TIME_ZONE` resolves to under test, so the
 * migrated code and the code it replaced agree. The test below that renders
 * under `America/Denver` is the one that can tell them apart.
 */
const CLUB_TODAY = "2026-07-01";

/**
 * The club's day at the same frozen instant for a club in `America/Denver` —
 * six hours behind UTC, so still 30 June when Auckland has ticked over. This is
 * the value no environment read can produce here.
 */
const DENVER_TODAY = "2026-06-30";

function payload(options: {
  decisionDate?: string;
  membershipTypeName?: string;
  exemptMembers?: Array<{ memberId: string; memberName: string; ageTier: string | null }>;
} = {}) {
  const decisionDate = options.decisionDate ?? "2026-07-13";
  const membershipTypeName = options.membershipTypeName ?? "Full";
  return {
    preview: {
      seasonYear: 2026,
      decisionDate,
      dueDays: 30,
      totalCents: 12_000,
      confirmationToken: "a".repeat(64),
      entries: [{
        key: "entry-1",
        membershipTypeName,
        billingBasis: "PER_MEMBER",
        prorationRule: "NONE",
        chargedAmountCents: 12_000,
        coveredMonths: 12,
        xeroAccountCode: "203",
        xeroItemCode: "SUB",
        recipient: { name: "Member One" },
        coveredMembers: [{ id: "member-1", name: "Member One" }],
      }],
      exceptions: [{ fingerprint: "same", message: "Configure billing" }],
      exemptMembers: options.exemptMembers ?? [],
      alreadyInvoiced: [],
    },
    charges: [{
      id: "charge-1",
      status: "EMAIL_FAILED",
      membershipTypeName: "Full",
      chargedAmountCents: 12_000,
      recipientName: "Member One",
      xeroInvoiceNumber: "INV-1",
      lastErrorMessage: "Mail failed",
      coverage: [{ memberName: "Member One" }],
    }],
    exceptions: [{ id: "exception-1", fingerprint: "same", message: "Configure billing" }],
    settings: { invoiceDueDays: 30, familyBillingMode: "BILL_FAMILY_VIA_BILLING_MEMBER" },
  };
}

function successResponse(body = payload()) {
  return Promise.resolve({ ok: true, json: async () => body } as Response);
}

describe("subscription billing panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirm.mockResolvedValue(false);
    vi.stubGlobal("fetch", vi.fn(() => successResponse()));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps finance mutations disabled for view-only admins and deduplicates exceptions", async () => {
    mocks.canEdit.mockReturnValue(false);
    render(<SubscriptionBillingPanel seasonYear={2026} />);
    expect(await screen.findByText(/Finance view access can inspect/)).toBeTruthy();
    expect(screen.getByLabelText("Invoice due days").hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Save due days" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Confirm and queue annual batch" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Retry" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText("Configure billing")).toHaveLength(1);
    expect(screen.getByText("Open exceptions").nextSibling?.textContent).toBe("1");
  });

  it("removes an actionable preview immediately when its date changes and keeps it cleared after refresh failure", async () => {
    mocks.canEdit.mockReturnValue(true);
    const fetchMock = vi.mocked(fetch);
    render(<SubscriptionBillingPanel seasonYear={2026} />);
    expect((await screen.findByRole("button", { name: "Confirm and queue annual batch" })).hasAttribute("disabled")).toBe(false);
    fetchMock.mockRejectedValueOnce(new Error("preview unavailable"));
    fireEvent.change(screen.getByLabelText("Decision date"), { target: { value: "2026-08-01" } });
    expect(screen.queryByRole("button", { name: "Confirm and queue annual batch" })).toBeNull();
    expect(await screen.findByText("preview unavailable")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm and queue annual batch" })).toBeNull());
  });

  it("ignores an older preview response after the newer date request fails", async () => {
    mocks.canEdit.mockReturnValue(true);
    let resolveOlder: ((value: Response) => void) | undefined;
    const older = new Promise<Response>((resolve) => {
      resolveOlder = resolve;
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementationOnce(() => older);
    render(<SubscriptionBillingPanel seasonYear={2026} />);
    fetchMock.mockRejectedValueOnce(new Error("newer preview failed"));
    fireEvent.change(screen.getByLabelText("Decision date"), { target: { value: "2026-08-01" } });
    expect(await screen.findByText("newer preview failed")).toBeTruthy();

    await act(async () => {
      resolveOlder?.({ ok: true, json: async () => payload() } as Response);
      await older;
    });
    expect(screen.getByText("newer preview failed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm and queue annual batch" })).toBeNull();
  });

  it("clears a load error after refresh succeeds and preserves mutation success through its reload", async () => {
    mocks.canEdit.mockReturnValue(true);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new Error("temporary preview failure"));
    render(<SubscriptionBillingPanel seasonYear={2026} />);
    expect(await screen.findByText("temporary preview failure")).toBeTruthy();
    fetchMock.mockImplementationOnce(() => successResponse());
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    expect(await screen.findByRole("button", { name: "Confirm and queue annual batch" })).toBeTruthy();
    expect(screen.queryByText("temporary preview failure")).toBeNull();

    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: "Due days saved" }) } as never)
      .mockImplementationOnce(() => successResponse());
    fireEvent.click(screen.getByRole("button", { name: "Save due days" }));
    expect(await screen.findByText("Due days saved")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm and queue annual batch" })).toBeTruthy());
    expect(screen.getByText("Due days saved")).toBeTruthy();
  });

  it("saves the selected family billing mode with the current due days", async () => {
    mocks.canEdit.mockReturnValue(true);
    const fetchMock = vi.mocked(fetch);
    render(<SubscriptionBillingPanel seasonYear={2026} />);
    await screen.findByRole("button", { name: "Save billing mode" });
    // Switch the mode via the Select, then save.
    const trigger = screen.getByRole("combobox", { name: "Family billing mode" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "Bill members individually" }));
    fetchMock.mockClear();
    fetchMock.mockImplementationOnce(() => Promise.resolve({ ok: true, json: async () => ({ message: "Subscription billing settings updated." }) } as Response));
    fireEvent.click(screen.getByRole("button", { name: "Save billing mode" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(true));
    const postCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((postCall![1] as RequestInit).body))).toEqual({
      action: "UPDATE_SETTINGS", invoiceDueDays: 30, familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY",
    });
  });

  it("saves the billing mode with the last-saved due days, ignoring an unsaved due-days edit", async () => {
    mocks.canEdit.mockReturnValue(true);
    const fetchMock = vi.mocked(fetch);
    render(<SubscriptionBillingPanel seasonYear={2026} />);
    await screen.findByRole("button", { name: "Save billing mode" });
    // Type a new due-days value but do NOT save it, then save the mode.
    fireEvent.change(screen.getByLabelText("Invoice due days"), { target: { value: "45" } });
    const trigger = screen.getByRole("combobox", { name: "Family billing mode" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "Bill members individually" }));
    fetchMock.mockClear();
    fetchMock.mockImplementationOnce(() => Promise.resolve({ ok: true, json: async () => ({ message: "Subscription billing settings updated." }) } as Response));
    fireEvent.click(screen.getByRole("button", { name: "Save billing mode" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(true));
    const postCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    // The unsaved "45" is not persisted; the last-saved 30 is sent instead.
    expect(JSON.parse(String((postCall![1] as RequestInit).body))).toEqual({
      action: "UPDATE_SETTINGS", invoiceDueDays: 30, familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY",
    });
  });

  // #2148 (D1): exempt members render in the collapsed informational section.
  it("shows the collapsed Exempt section with a count", async () => {
    mocks.canEdit.mockReturnValue(true);
    vi.mocked(fetch).mockImplementation(() => successResponse(payload({
      exemptMembers: [
        { memberId: "kid-1", memberName: "Kid One", ageTier: "CHILD" },
        { memberId: "kid-2", memberName: "Kid Two", ageTier: "INFANT" },
      ],
    })));
    render(<SubscriptionBillingPanel seasonYear={2026} />);
    expect(await screen.findByText(/Exempt \(2\)/)).toBeTruthy();
    expect(screen.getByText("Kid One")).toBeTruthy();
    expect(screen.getByText("Kid Two")).toBeTruthy();
  });

  // #2148 (D2 / constraint 3): a finance-EDIT admin's Refresh reconciles via the
  // edit-gated POST action; a finance-VIEW admin's Refresh stays a read-only GET.
  it("Refresh posts REFRESH_PREVIEW for a finance-edit admin", async () => {
    mocks.canEdit.mockReturnValue(true);
    const fetchMock = vi.mocked(fetch);
    render(<SubscriptionBillingPanel seasonYear={2026} />);
    await screen.findByRole("button", { name: "Confirm and queue annual batch" });
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (_input, init) =>
      (init as RequestInit | undefined)?.method === "POST"
        ? ({ ok: true, json: async () => ({ success: true, message: "Preview refreshed.", ...payload() }) } as Response)
        : successResponse());
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(true));
    const postCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((postCall![1] as RequestInit).body))).toEqual({
      action: "REFRESH_PREVIEW", seasonYear: 2026, decisionDate: CLUB_TODAY,
    });
  });

  it("Refresh stays a read-only GET for a finance-view admin", async () => {
    mocks.canEdit.mockReturnValue(false);
    const fetchMock = vi.mocked(fetch);
    render(<SubscriptionBillingPanel seasonYear={2026} />);
    await screen.findByText("Open exceptions");
    fetchMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== "POST")).toBe(true);
  });

  /**
   * THE DISCRIMINATING ONE (CT-4, #2870).
   *
   * The default decision date is a BUSINESS DECISION derived from "today", and
   * `INV-CONFIG-002` says which today: the club's, from the persisted
   * `ClubTimeSettings.timeZone`. Everything else in this file renders under
   * `Pacific/Auckland`, which is also what `APP_TIME_ZONE` resolves to under
   * test — so those assertions cannot tell the persisted zone from the
   * environment, and would pass just as happily against the code this change
   * replaced.
   *
   * `America/Denver` can. At the frozen instant `2026-07-01T00:00:00.000Z` the
   * club day in Denver is 30 JUNE, where Auckland, the host (UTC on CI) and
   * `APP_TIME_ZONE` all say 1 July. So the request below carries `2026-06-30`
   * only if the panel really asked the persisted zone.
   */
  it("seeds the decision date from the club's PERSISTED zone, not APP_TIME_ZONE or the host", async () => {
    // Premise, asserted rather than assumed: the two zones must disagree on
    // this instant, or the expectation below is vacuous. An identifier check —
    // "the environment is not America/Denver" — would pass under
    // America/Chicago while proving nothing.
    expect(DENVER_TODAY).not.toBe(CLUB_TODAY);

    mocks.canEdit.mockReturnValue(true);
    const fetchMock = vi.mocked(fetch);
    render(<SubscriptionBillingPanel seasonYear={2026} />, {
      wrapper: ({ children }) => (
        <ClubTimeProvider zone="America/Denver">{children}</ClubTimeProvider>
      ),
    });
    await screen.findByRole("button", { name: "Confirm and queue annual batch" });

    const requested = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes("decisionDate="));
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((url) => url.includes(`decisionDate=${DENVER_TODAY}`))).toBe(true);
    expect(requested.some((url) => url.includes(`decisionDate=${CLUB_TODAY}`))).toBe(false);

    // And the operator sees the same day in the field they can change.
    expect(
      (screen.getByLabelText("Decision date") as HTMLInputElement).value,
    ).toBe(DENVER_TODAY);
  });

  // #2161 (D2): mark a PER_FAMILY entry as already invoiced (with an optional note).
  it("marks a family as already invoiced from a PER_FAMILY entry", async () => {
    mocks.canEdit.mockReturnValue(true);
    const famPayload = {
      ...payload(),
      preview: {
        ...payload().preview,
        entries: [{
          key: "fam-1", membershipTypeName: "Family", billingBasis: "PER_FAMILY", prorationRule: "NONE",
          chargedAmountCents: 20_000, coveredMonths: 12, familyGroupId: "family-1", xeroAccountCode: "203", xeroItemCode: "SUB",
          recipient: { name: "Bill Member" }, coveredMembers: [{ id: "c1", name: "Child One" }],
        }],
      },
    };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input, init) => (init as RequestInit | undefined)?.method === "POST"
      ? ({ ok: true, json: async () => ({ message: "Family marked as already invoiced for this season." }) } as Response)
      : ({ ok: true, json: async () => famPayload } as Response));
    render(<SubscriptionBillingPanel seasonYear={2026} />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark family as already invoiced" }));
    fireEvent.change(screen.getByLabelText(/Note \(optional\)/), { target: { value: "INV-9" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirm.*mark as already invoiced/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(true));
    const postCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((postCall![1] as RequestInit).body))).toEqual({
      action: "MARK_FAMILY_INVOICED", seasonYear: 2026, familyGroupId: "family-1", note: "INV-9",
    });
  });

  // #2161 (D2): an operator-marked family shows the indicator and an Unmark control.
  it("unmarks an operator-marked family after confirming", async () => {
    mocks.canEdit.mockReturnValue(true);
    mocks.confirm.mockResolvedValue(true);
    const famPayload = {
      ...payload(),
      preview: {
        ...payload().preview,
        entries: [],
        alreadyInvoiced: [],
        alreadyInvoicedFamilies: [{
          familyGroupId: "family-1", holderMemberId: null, holderName: null, xeroInvoiceNumber: null, status: null,
          membersCovered: 3, operatorMarked: true, markerNote: "INV-9", markedByName: "Ada Admin", markedAt: null,
        }],
      },
    };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input, init) => (init as RequestInit | undefined)?.method === "POST"
      ? ({ ok: true, json: async () => ({ message: "Family marker removed; it can be billed again." }) } as Response)
      : ({ ok: true, json: async () => famPayload } as Response));
    render(<SubscriptionBillingPanel seasonYear={2026} />);
    expect(await screen.findByText("Operator marked")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unmark" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(true));
    const postCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((postCall![1] as RequestInit).body))).toEqual({
      action: "UNMARK_FAMILY_INVOICED", seasonYear: 2026, familyGroupId: "family-1",
    });
  });

  it("reloads the latest selection when an older-selection mutation completes", async () => {
    mocks.canEdit.mockReturnValue(true);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockReset();
    let resolvePost: ((value: Response) => void) | undefined;
    const pendingPost = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    const getUrls: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "POST") return pendingPost;
      const url = String(input);
      getUrls.push(url);
      if (url.includes("decisionDate=2026-08-01")) {
        return { ok: true, json: async () => payload({ decisionDate: "2026-08-01", membershipTypeName: "August Full" }) } as Response;
      }
      return { ok: true, json: async () => payload() } as Response;
    });

    render(<SubscriptionBillingPanel seasonYear={2026} />);
    expect(await screen.findByText(/^Full · Member One$/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save due days" }));
    fireEvent.change(screen.getByLabelText("Decision date"), { target: { value: "2026-08-01" } });
    expect(await screen.findByText(/^August Full · Member One$/)).toBeTruthy();

    await act(async () => {
      resolvePost?.({ ok: true, json: async () => ({ message: "Due days saved" }) } as Response);
      await pendingPost;
    });
    expect(await screen.findByText("Due days saved")).toBeTruthy();
    expect(await screen.findByText(/^August Full · Member One$/)).toBeTruthy();
    expect(screen.queryByText(/^Full · Member One$/)).toBeNull();
    expect(screen.getByRole("button", { name: "Confirm and queue annual batch" }).hasAttribute("disabled")).toBe(false);
    expect(getUrls.at(-1)).toContain("decisionDate=2026-08-01");
  });
});
