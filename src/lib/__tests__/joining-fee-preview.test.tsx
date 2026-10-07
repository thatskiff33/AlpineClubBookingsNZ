// @vitest-environment jsdom
//
// Item 15 (#1931, E5): the blind-override surfaces fetch the joining-fee preview
// and surface the default amount + narration, prefilling the override fields so
// overriding is an informed choice.
import { render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UseXeroEntranceFeeDecisionResult } from "@/lib/admin-xero-entrance-fee";
import { MemberXeroEntranceFeeFields } from "@/app/(admin)/admin/members/_components/member-xero-entrance-fee-fields";
import { MemberXeroCreateDialog } from "@/app/(admin)/admin/members/[id]/_components/member-xero-create-dialog";

const fetchMock = vi.fn();

const ADULT_PREVIEW = {
  defaultAmountCents: 10000,
  defaultNarration: "Membership joining fee (Adult)",
  exempt: false,
  effectiveFrom: "2026-01-01",
  source: "SCHEDULE" as const,
};

function makeDecision(overrides: Partial<UseXeroEntranceFeeDecisionResult> = {}): UseXeroEntranceFeeDecisionResult {
  return {
    xeroCreateEntranceFeeInvoice: true,
    setXeroCreateEntranceFeeInvoice: vi.fn(),
    xeroEntranceFeeSkipReason: "",
    setXeroEntranceFeeSkipReason: vi.fn(),
    xeroEntranceFeeAmount: "",
    setXeroEntranceFeeAmount: vi.fn(),
    xeroEntranceFeeNarration: "",
    setXeroEntranceFeeNarration: vi.fn(),
    resetXeroEntranceFeeDecision: vi.fn(),
    buildXeroEntranceFeeInvoiceOptions: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = fetchMock as typeof fetch;
  fetchMock.mockResolvedValue({ ok: true, json: async () => ADULT_PREVIEW });
});

describe("MemberXeroEntranceFeeFields (existing member)", () => {
  it("fetches the preview, prefills amount + narration, and shows the default", async () => {
    const decision = makeDecision();
    render(
      <MemberXeroEntranceFeeFields idPrefix="edit" decision={decision} onClearError={() => {}} memberId="m1" />,
    );

    await waitFor(() =>
      expect(decision.setXeroEntranceFeeNarration).toHaveBeenCalledWith("Membership joining fee (Adult)"),
    );
    expect(decision.setXeroEntranceFeeAmount).toHaveBeenCalledWith("100.00");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/members/m1/joining-fee/preview"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(await screen.findByText(/Default:/)).toBeTruthy();
    expect(screen.getByText(/Membership joining fee \(Adult\)/)).toBeTruthy();
  });

  it("does not prefill when a field is already filled (never clobbers an edit)", async () => {
    const decision = makeDecision({ xeroEntranceFeeNarration: "Custom wording" });
    render(
      <MemberXeroEntranceFeeFields idPrefix="edit" decision={decision} onClearError={() => {}} memberId="m1" />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Amount was empty -> prefilled; narration was non-empty -> left alone.
    await waitFor(() => expect(decision.setXeroEntranceFeeAmount).toHaveBeenCalledWith("100.00"));
    expect(decision.setXeroEntranceFeeNarration).not.toHaveBeenCalled();
  });

  it("surfaces the exempt state without prefilling", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        defaultAmountCents: null,
        defaultNarration: "Membership joining fee (Adult)",
        exempt: true,
        exemptReason: "Organisations and schools (N/A age tier) are exempt from joining fees.",
        effectiveFrom: null,
        source: "NONE",
      }),
    });
    const decision = makeDecision();
    render(
      <MemberXeroEntranceFeeFields idPrefix="edit" decision={decision} onClearError={() => {}} memberId="org1" />,
    );
    expect(await screen.findByText(/Exempt from joining fees/)).toBeTruthy();
    expect(decision.setXeroEntranceFeeAmount).not.toHaveBeenCalled();
    expect(decision.setXeroEntranceFeeNarration).not.toHaveBeenCalled();
  });

  it("does not fetch a preview for the new-member create form (no memberId)", async () => {
    const decision = makeDecision();
    render(<MemberXeroEntranceFeeFields idPrefix="create" decision={decision} onClearError={() => {}} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(decision.setXeroEntranceFeeNarration).not.toHaveBeenCalled();
  });
});

describe("MemberXeroCreateDialog (create-contact-then-invoice)", () => {
  const member = { id: "m2", firstName: "Pat", lastName: "Member" } as never;

  it("fetches the preview and prefills the create-flow override fields", async () => {
    const onChangeAmount = vi.fn();
    const onChangeNarration = vi.fn();
    render(
      <MemberXeroCreateDialog
        open
        onOpenChange={() => {}}
        member={member}
        pushing={false}
        error=""
        createEntranceFeeInvoice
        entranceFeeSkipReason=""
        entranceFeeAmount=""
        entranceFeeNarration=""
        onChangeCreateEntranceFeeInvoice={() => {}}
        onChangeEntranceFeeSkipReason={() => {}}
        onChangeEntranceFeeAmount={onChangeAmount}
        onChangeEntranceFeeNarration={onChangeNarration}
        onSubmit={() => {}}
      />,
    );

    await waitFor(() => expect(onChangeNarration).toHaveBeenCalledWith("Membership joining fee (Adult)"));
    expect(onChangeAmount).toHaveBeenCalledWith("100.00");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/members/m2/joining-fee/preview"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(await screen.findByText(/Default:/)).toBeTruthy();
  });
});
