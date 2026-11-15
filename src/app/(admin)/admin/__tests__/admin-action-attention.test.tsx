// @vitest-environment jsdom

/*
  #4975 (ALP-578) — admin surfaces that used to share one error box between a
  background load and the officer's own actions. A failed load stays passive
  and moves nothing; a failed action takes focus, and takes it AGAIN when the
  same failure repeats word for word.
*/

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";
import RefundRequestsPage from "../finance/refund-requests/page";
import AgeTierSettingsPage from "../rules/age-tier-settings/page";
import { MountainConditionsPanel } from "../website/mountain-conditions/_components/mountain-conditions-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => "/admin",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
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

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

vi.setConfig({ testTimeout: 45_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const failing = (message: string, status = 500) => ({
  ok: false,
  status,
  json: async () => ({ error: message }),
});

/** Moves focus back to `control`, as an admin returning to it would. */
function refocus(control: HTMLElement) {
  control.focus();
  expect(document.activeElement).toBe(control);
}

/** A failed load must leave focus where it was and the action alert empty. */
async function expectPassiveLoadFailure(message: string, actionAlertId: string) {
  const before = document.activeElement;
  await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument());
  const actionAlert = document.getElementById(actionAlertId);
  expect(actionAlert).toBeEmptyDOMElement();
  // Give any (wrongly) scheduled focus effect its turns before checking.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.activeElement).toBe(before);
  expect(screen.getByText(message).closest('[tabindex="-1"]')).toBeNull();
}

describe("refund and credit review queue", () => {
  const CREDIT = {
    id: "credit-1",
    memberId: "member-1",
    amountCents: 2500,
    description: "Goodwill for a cancelled trip",
    grantAccount: "GOODWILL",
    status: "PENDING",
    createdAt: "2026-06-20T01:00:00.000Z",
    reviewedAt: null,
    member: { id: "member-1", firstName: "Ana", lastName: "Reviewer", email: "ana@club.test" },
    requestedBy: { id: "admin-2", firstName: "Other", lastName: "Admin" },
    reviewedBy: null,
    approvedCredit: null,
  };

  it("keeps a failed queue load passive", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => failing("down")));
    render(<RefundRequestsPage />);
    await expectPassiveLoadFailure(
      "Failed to load review queue",
      "refund-review-action-error",
    );
  });

  it("focuses a refused credit review, and focuses it again when it repeats", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") return failing("Credit already reviewed.");
        if (url.startsWith("/api/admin/credit-approvals")) return ok([CREDIT]);
        return ok([]);
      }),
    );
    render(<RefundRequestsPage />);
    const alert = document.getElementById("refund-review-action-error");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reject = await screen.findByRole("button", { name: "Reject" });
      refocus(reject);
      fireEvent.click(reject);
      await waitFor(() => expect(alert).toHaveTextContent("Credit already reviewed."));
      await expectRecoveryAlertToHoldFocus(alert);
    }
  });

  it("focuses an invalid refund amount each time Approve is pressed", async () => {
    const appeal = {
      id: "appeal-1",
      bookingId: "booking-1",
      memberId: "member-1",
      reason: "Snowed in",
      requestedAmountCents: null,
      status: "PENDING",
      adminNotes: null,
      approvedAmountCents: null,
      reviewedAt: null,
      createdAt: "2026-06-20T01:00:00.000Z",
      booking: {
        id: "booking-1",
        checkIn: "2026-08-01",
        checkOut: "2026-08-03",
        finalPriceCents: 10000,
        status: "CANCELLED",
        noEmails: false,
        creditsFromCancellation: [],
        payment: null,
        appealCeilingCents: 0,
        appealCardRefundOwedCents: 0,
      },
      member: { id: "member-1", firstName: "Ana", lastName: "Appellant", email: "ana@club.test" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/admin/refund-requests") ? ok([appeal]) : ok([]),
      ),
    );
    render(<RefundRequestsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    const alert = document.getElementById("refund-review-action-error");

    // The clear and the identical refusal land in one handler, so only the
    // attention key tells the alert this is a new failure.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const approve = screen.getByRole("button", { name: "Approve & Refund" });
      refocus(approve);
      fireEvent.click(approve);
      await waitFor(() => expect(alert).toHaveTextContent("Please enter a valid refund amount"));
      await expectRecoveryAlertToHoldFocus(alert);
    }
  });
});

describe("age tier settings", () => {
  it("keeps a failed settings load passive", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    render(<AgeTierSettingsPage />);
    await expectPassiveLoadFailure("Failed to load settings", "age-tier-save-error");
  });

  it("focuses a refused save, and focuses it again when it repeats", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "PUT" ? failing("A member is still in that tier.", 400) : ok({ settings: [] }),
      ),
    );
    render(<AgeTierSettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const alert = document.getElementById("age-tier-save-error");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const save = await screen.findByRole("button", { name: "Save Changes" });
      refocus(save);
      fireEvent.click(save);
      await waitFor(() => expect(alert).toHaveTextContent("A member is still in that tier."));
      await expectRecoveryAlertToHoldFocus(alert);
    }
  });
});

describe("mountain conditions", () => {
  it("keeps a failed load passive, then focuses a repeated refresh failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? failing("Upstream unreachable.", 502)
          : failing("Conditions unavailable."),
      ),
    );
    render(<MountainConditionsPanel />);
    await expectPassiveLoadFailure(
      "Conditions unavailable.",
      "mountain-conditions-action-error",
    );

    const alert = document.getElementById("mountain-conditions-action-error");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refresh = await screen.findByRole("button", { name: /Update from upstream/ });
      refocus(refresh);
      fireEvent.click(refresh);
      await waitFor(() => expect(alert).toHaveTextContent("Upstream unreachable."));
      await expectRecoveryAlertToHoldFocus(alert);
    }
  });
});
