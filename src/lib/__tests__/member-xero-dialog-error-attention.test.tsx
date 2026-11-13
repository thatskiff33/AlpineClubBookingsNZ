// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemberXeroCreateDialog } from "@/app/(admin)/admin/membership/members/[id]/_components/member-xero-create-dialog";
import { MemberXeroDecisionDialog } from "@/app/(admin)/admin/membership/members/[id]/_components/member-xero-decision-dialog";
import { MemberXeroLinkDialog } from "@/app/(admin)/admin/membership/members/[id]/_components/member-xero-link-dialog";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

const RETRY_MESSAGE =
  "The database update could not be completed because this booking or member changed. Reload before trying again. If a payment was involved, check its status before retrying.";

const member = {
  id: "member-1",
  firstName: "Pat",
  lastName: "Family",
} as never;

const contact = {
  contactId: "xero-contact-1",
  name: "Pat Family",
  email: "pat@example.org",
  isLinked: false,
  linkedMemberName: null,
};

function expectPermanentEmptyAlert(id: string) {
  const alert = document.getElementById(id);
  expect(alert).toHaveAttribute("role", "alert");
  expect(alert).toBeEmptyDOMElement();
  expect(alert).toHaveClass("sr-only");
  return alert;
}

async function expectFocusedRetry(
  alert: HTMLElement,
  scrollIntoView: ReturnType<typeof vi.fn>,
) {
  await waitFor(() => expect(alert).toHaveTextContent(RETRY_MESSAGE));
  await expectRecoveryAlertToHoldFocus(alert);
  expect(scrollIntoView).toHaveBeenCalledWith({
    behavior: "smooth",
    block: "center",
  });
}

describe("member Xero dialog participant retry attention (#2597)", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    } else {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown })
        .scrollIntoView;
    }
  });

  it("keeps the link search and focuses a link retry", async () => {
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      member,
      query: "pat@example.org",
      results: [contact],
      searching: false,
      linking: false,
      error: "",
      onChangeQuery: vi.fn(),
      onClearError: vi.fn(),
      onSearch: vi.fn(),
      onLink: vi.fn(),
    };
    const { rerender } = render(<MemberXeroLinkDialog {...props} />);
    const alert = expectPermanentEmptyAlert("member-xero-link-error");

    rerender(<MemberXeroLinkDialog {...props} error={RETRY_MESSAGE} />);

    await expectFocusedRetry(alert!, scrollIntoView);
    expect(screen.getByDisplayValue("pat@example.org")).toBeInTheDocument();
    expect(screen.getByText("Pat Family")).toBeInTheDocument();
  });

  it("keeps the create decision draft and focuses a create retry", async () => {
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      member,
      pushing: false,
      error: "",
      createEntranceFeeInvoice: false,
      entranceFeeSkipReason: "Family already paid the joining fee.",
      entranceFeeAmount: "",
      entranceFeeNarration: "",
      onChangeCreateEntranceFeeInvoice: vi.fn(),
      onChangeEntranceFeeSkipReason: vi.fn(),
      onChangeEntranceFeeAmount: vi.fn(),
      onChangeEntranceFeeNarration: vi.fn(),
      onSubmit: vi.fn(),
    };
    const { rerender } = render(<MemberXeroCreateDialog {...props} />);
    const alert = expectPermanentEmptyAlert("member-xero-create-error");

    rerender(<MemberXeroCreateDialog {...props} error={RETRY_MESSAGE} />);

    await expectFocusedRetry(alert!, scrollIntoView);
    expect(
      screen.getByDisplayValue("Family already paid the joining fee."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("keeps the selected candidate and focuses a decision retry", async () => {
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      member,
      results: [contact],
      selectedContactId: contact.contactId,
      createEntranceFeeInvoice: false,
      linking: false,
      pushing: false,
      error: "",
      onSelectContact: vi.fn(),
      onConfirmLink: vi.fn(),
      onCreateAnyway: vi.fn(),
    };
    const { rerender } = render(<MemberXeroDecisionDialog {...props} />);
    const alert = expectPermanentEmptyAlert("member-xero-decision-error");

    rerender(<MemberXeroDecisionDialog {...props} error={RETRY_MESSAGE} />);

    await expectFocusedRetry(alert!, scrollIntoView);
    expect(screen.getByRole("radio", { name: /Pat Family/i })).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Link Selected Contact" }),
    ).toBeEnabled();
  });
});
