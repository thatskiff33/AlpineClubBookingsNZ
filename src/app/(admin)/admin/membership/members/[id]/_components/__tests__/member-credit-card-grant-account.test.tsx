// @vitest-environment jsdom

// The account choice on a manual credit grant (#4431): two radios, required
// before submit, and a pending request shows the chosen account to the
// approver. A positive request stored with no account can be rejected and
// cannot be approved.

import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemberCreditCard } from "@/app/(admin)/admin/membership/members/[id]/_components/member-credit-card";
import type { PendingCreditAdjustmentItem } from "@/app/(admin)/admin/membership/members/[id]/_types";
import { GRANT_ACCOUNT_MISSING_MESSAGE } from "@/lib/admin-credit-grant-account";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "approver",
        adminPermissionMatrix: {
          overview: "view",
          bookings: "view",
          membership: "view",
          finance: "edit",
          lodge: "view",
          content: "view",
          support: "view",
        } satisfies AdminPermissionMatrix,
      },
    },
    status: "authenticated",
  }),
}));

const requester = { id: "requester", firstName: "Ada", lastName: "Lovelace" };

function pending(overrides: Partial<PendingCreditAdjustmentItem> = {}): PendingCreditAdjustmentItem {
  return {
    id: "req-1",
    amountCents: 2500,
    description: "Double charge",
    createdAt: "2026-07-01T00:00:00.000Z",
    grantAccount: "MEMBER_OWN_MONEY",
    requestedBy: requester,
    ...overrides,
  };
}

function props(
  overrides: Partial<ComponentProps<typeof MemberCreditCard>> = {},
): ComponentProps<typeof MemberCreditCard> {
  return {
    creditBalance: 0,
    creditHistory: [],
    creditLoading: false,
    creditError: "",
    pendingAdjustmentRequests: [],
    reviewingAdjustmentId: null,
    showAdjustmentForm: true,
    adjustmentError: "",
    adjustmentAmount: "25.00",
    adjustmentDescription: "Double charge",
    adjustmentSaving: false,
    onToggleAdjustmentForm: vi.fn(),
    onChangeAdjustmentAmount: vi.fn(),
    onChangeAdjustmentDescription: vi.fn(),
    onSubmitAdjustment: vi.fn(),
    onReviewAdjustment: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);

describe("MemberCreditCard grant account (#4431)", () => {
  it("requires one of the two accounts before a positive grant can be submitted", () => {
    const onSubmitAdjustment = vi.fn();
    render(<MemberCreditCard {...props({ onSubmitAdjustment })} />);

    const own = screen.getByRole("radio", { name: "Member's own money (overpayment, double charge)" });
    const goodwill = screen.getByRole("radio", { name: "Goodwill" });
    const submit = screen.getByRole("button", { name: "Submit for Approval" });

    expect(own).not.toBeChecked();
    expect(goodwill).not.toBeChecked();
    expect(submit).toBeDisabled();

    fireEvent.click(goodwill);
    expect(goodwill).toBeChecked();
    expect(own).not.toBeChecked();
    expect(submit).toBeEnabled();

    fireEvent.click(submit);
    expect(onSubmitAdjustment).toHaveBeenCalledWith("GOODWILL");
  });

  it("omits the account choice on a deduction", () => {
    const onSubmitAdjustment = vi.fn();
    render(
      <MemberCreditCard
        {...props({ adjustmentAmount: "-10.00", onSubmitAdjustment })}
      />,
    );

    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Submit for Approval" }));
    expect(onSubmitAdjustment).toHaveBeenCalledWith(null);
  });

  it("shows the chosen account to the approver, and withholds Approve when none was stored", () => {
    const onReviewAdjustment = vi.fn();
    render(
      <MemberCreditCard
        {...props({
          showAdjustmentForm: false,
          onReviewAdjustment,
          pendingAdjustmentRequests: [
            pending(),
            pending({
              id: "req-old",
              description: "Old grant",
              grantAccount: null,
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText("Member's own money (overpayment, double charge)")).toBeTruthy();
    expect(screen.getByText(GRANT_ACCOUNT_MISSING_MESSAGE)).toBeTruthy();

    const approve = screen.getAllByRole("button", { name: "Approve" });
    expect(approve).toHaveLength(1);
    fireEvent.click(approve[0]);
    expect(onReviewAdjustment).toHaveBeenCalledWith("req-1", "APPROVE");

    const reject = screen.getAllByRole("button", { name: "Reject" });
    expect(reject).toHaveLength(2);
    fireEvent.click(reject[1]);
    expect(onReviewAdjustment).toHaveBeenCalledWith("req-old", "REJECT");
  });
});
