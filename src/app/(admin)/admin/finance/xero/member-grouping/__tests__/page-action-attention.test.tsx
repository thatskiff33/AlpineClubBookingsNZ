// @vitest-environment jsdom

/**
 * Member grouping: a failed refresh of the Xero contact-group cache is a read
 * and stays a passive notice; a failed mode change is a write and takes focus,
 * again on every identical failure (#4975).
 */

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

const mocks = vi.hoisted(() => ({ loadGroups: vi.fn() }));

vi.mock("@/lib/admin-xero-contact-groups", () => ({
  loadAdminXeroContactGroups: mocks.loadGroups,
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "admin-1", adminPermissionMatrix: { finance: "edit" } } },
  }),
}));

import XeroMemberGroupingPage from "@/app/(admin)/admin/finance/xero/member-grouping/page";

const CONFIG = {
  mode: "MEMBERSHIP_TYPE_AND_AGE",
  rules: [],
  groups: [{ id: "g_adults", name: "Adults group", contactCount: 4 }],
  lastRefreshedAt: "2026-06-30T00:00:00.000Z",
  membershipTypes: [{ id: "mt_full", name: "Full" }],
  ageTiers: ["INFANT", "CHILD", "YOUTH", "ADULT", "NOT_APPLICABLE"],
};

const fetchMock = vi.fn();
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

beforeEach(() => {
  fetchMock.mockReset();
  mocks.loadGroups.mockReset();
  global.fetch = fetchMock as typeof fetch;
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: originalScrollIntoView,
    });
  } else {
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

function actionAlert() {
  const alert = document.getElementById("xero-member-grouping-action-error");
  if (!alert) throw new Error("no action alert");
  return alert;
}

describe("XeroMemberGroupingPage failure attention", () => {
  it("leaves focus on Refresh from Xero when the read-only refresh fails", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => CONFIG });
    mocks.loadGroups.mockRejectedValue(new Error("Xero contact groups unavailable"));
    render(<XeroMemberGroupingPage />);
    const refresh = () => screen.getByRole("button", { name: /refresh from xero/i });
    await waitFor(() => expect(refresh()).toBeEnabled());

    act(() => refresh().focus());
    fireEvent.click(refresh());
    expect(await screen.findByText("Xero contact groups unavailable")).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(refresh());
    expect(actionAlert()).toBeEmptyDOMElement();
  });

  it("focuses a refused mode change every time it is refused", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? { ok: false, status: 409, json: async () => ({ error: "Mode change refused" }) }
        : { ok: true, json: async () => CONFIG },
    );
    render(<XeroMemberGroupingPage />);
    const noneRadio = () => screen.getByRole("radio", { name: /^none/i });
    await waitFor(() => expect(noneRadio()).toBeEnabled());

    fireEvent.click(noneRadio());
    const alert = actionAlert();
    await waitFor(() => expect(alert).toHaveTextContent("Mode change refused"));
    await expectRecoveryAlertToHoldFocus(alert);

    await waitFor(() => expect(noneRadio()).toBeEnabled());
    act(() => noneRadio().focus());
    fireEvent.click(noneRadio());
    await expectRecoveryAlertToHoldFocus(alert);
    expect(alert).toHaveTextContent("Mode change refused");
  });
});
