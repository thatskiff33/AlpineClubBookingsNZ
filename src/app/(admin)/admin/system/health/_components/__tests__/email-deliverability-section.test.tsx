// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({ canEdit: true }));
const dialog = vi.hoisted(() => ({ confirm: vi.fn(), prompt: vi.fn() }));

vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({ ...dialog, confirmDialog: null }),
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  ADMIN_VIEW_ONLY_ACTION_REASON:
    "Your admin role can view this area but cannot make changes.",
  useAdminAreaEditAccess: () => access.canEdit,
}));

import { EmailDeliverabilitySection } from "@/app/(admin)/admin/system/health/_components/email-deliverability-section";
import type { HealthData } from "@/app/(admin)/admin/system/health/_components/types";

const SECURITY_RETIREMENT_REASON =
  "Not retried: this booking email predates retry-time recipient authorization context (#2362). Re-send it by hand if the recipient still needs it.";
const PROVIDER_REASON =
  'SMTP rejected <img src=x onerror="window.pwned=true">';

type Failure = HealthData["emailFailures"]["failures"][number];

function failure(
  id: string,
  to: string,
  errorMessage: string | null,
  overrides: Partial<Failure> = {},
): Failure {
  return {
    id,
    to,
    subject: "Booking confirmation",
    templateName: "booking-confirmation",
    attempts: 3,
    lastAttemptAt: "2026-08-01T01:00:00.000Z",
    errorMessage,
    createdAt: "2026-08-01T00:00:00.000Z",
    bookingId: null,
    bookingExists: false,
    bookingRecipientMemberId: null,
    recovery: "retired",
    reviewedAt: null,
    reviewedById: null,
    reviewNote: null,
    ...overrides,
  };
}

function renderSection(
  failures: Failure[],
  summary: Partial<HealthData["emailFailures"]["summary"]> = {},
  handlers: { onRefresh?: () => Promise<void>; onError?: (message: string) => void } = {},
) {
  return render(
    <EmailDeliverabilitySection
      emailDeliverability={{
        summary: {
          activeCount: 0,
          bounceCount: 0,
          complaintCount: 0,
          eventsLast24h: 0,
        },
        suppressions: [],
      }}
      emailFailures={{
        summary: {
          activeCount: failures.length,
          reviewedCount: 0,
          scannedCount: failures.length,
          totalExhaustedCount: failures.length,
          scanLimit: 200,
          scanCapped: false,
          maxAttempts: 3,
          ...summary,
        },
        failures,
        recentlyReviewed: [],
      }}
      adminAlertDelivery={{
        summary: { recentCount: 0, lookbackDays: 7 },
        escalations: [],
      }}
      tokenEmailRecovery={{
        summary: { activeCount: 0, reissuedCount: 0, scannedCount: 0 },
        failures: [],
        recentlyReissued: [],
      }}
      onRefresh={handlers.onRefresh ?? vi.fn()}
      onError={handlers.onError ?? vi.fn()}
    />,
  );
}

const rowFor = (to: string) =>
  screen.getByRole("group", { name: `Email failure for ${to}` });

describe("EmailDeliverabilitySection exhausted failures", () => {
  beforeEach(() => {
    access.canEdit = true;
    dialog.confirm.mockReset();
    vi.unstubAllGlobals();
  });

  it("labels and renders authoritative security and provider reasons as escaped text", () => {
    const { container } = renderSection([
      failure("legacy", "legacy@example.com", SECURITY_RETIREMENT_REASON),
      failure("provider", "provider@example.com", PROVIDER_REASON),
    ]);

    const legacyRow = screen.getByRole("group", {
      name: "Email failure for legacy@example.com",
    });
    expect(within(legacyRow).getByText("Failure reason:")).toBeVisible();
    expect(within(legacyRow).getByText(SECURITY_RETIREMENT_REASON)).toBeVisible();

    const providerRow = screen.getByRole("group", {
      name: "Email failure for provider@example.com",
    });
    expect(within(providerRow).getByText("Failure reason:")).toBeVisible();
    expect(within(providerRow).getByText(PROVIDER_REASON)).toBeVisible();
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).toContain("&lt;img");
  });

  it("offers Try again only on rows that still hold a copy of their message (#4963)", () => {
    renderSection([
      failure("retry", "retry@example.com", "SMTP timeout", { recovery: "retry" }),
      failure("token", "token@example.com", null, {
        recovery: "token_reissue",
        templateName: "member-setup-invite",
      }),
      failure("sensitive", "sensitive@example.com", null, {
        recovery: "sensitive",
        templateName: "booking-confirmed",
      }),
      failure("retired", "retired@example.com", null),
    ]);

    const retryRow = rowFor("retry@example.com");
    expect(within(retryRow).getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(within(retryRow).queryByText(/can't be resent from here/)).toBeNull();

    for (const to of ["token@example.com", "sensitive@example.com", "retired@example.com"]) {
      const row = rowFor(to);
      expect(within(row).queryByRole("button", { name: "Try again" })).toBeNull();
      expect(within(row).getByText(/can't be resent from here/)).toBeVisible();
      expect(within(row).getByRole("button", { name: "Archive" })).toBeEnabled();
    }
    expect(
      within(rowFor("token@example.com")).getByText(/Reissue it from Token Email Recovery/),
    ).toBeVisible();
    expect(
      within(rowFor("sensitive@example.com")).getByText(/sign-in link, door code or payment link/),
    ).toBeVisible();
  });

  it("hands the row to the retry route after the officer confirms, then refreshes", async () => {
    dialog.confirm.mockResolvedValue(true);
    const fetchMock = vi.fn(async () => Response.json({ id: "email-1", requeued: true }));
    vi.stubGlobal("fetch", fetchMock);
    const onRefresh = vi.fn(async () => {});
    renderSection(
      [failure("email-1", "retry@example.com", null, { recovery: "retry" })],
      {},
      { onRefresh },
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(dialog.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringMatching(/next run/) }),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/email-failures/email-1/retry", {
      method: "POST",
    });
  });

  it("sends nothing when the officer cancels, and reports a refusal from the route", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "This email can no longer be tried again." }, { status: 409 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onError = vi.fn();
    renderSection(
      [failure("email-1", "retry@example.com", null, { recovery: "retry" })],
      {},
      { onError },
    );

    dialog.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(dialog.confirm).toHaveBeenCalledTimes(1));
    expect(fetchMock).not.toHaveBeenCalled();

    dialog.confirm.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("This email can no longer be tried again."),
    );
  });

  it("disables Try again for a view-only support admin, with the standard reason", () => {
    access.canEdit = false;
    renderSection([
      failure("retry", "retry@example.com", null, { recovery: "retry" }),
    ]);

    const button = within(rowFor("retry@example.com")).getByRole("button", {
      name: "Try again",
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "Your admin role can view this area but cannot make changes.",
    );
  });

  it("links a row to its booking and member, and says when the booking is gone", () => {
    renderSection([
      failure("linked", "linked@example.com", null, {
        bookingId: "booking-1",
        bookingExists: true,
        bookingRecipientMemberId: "member-1",
      }),
      failure("deleted", "deleted@example.com", null, {
        bookingId: "booking-gone",
        bookingExists: false,
      }),
      failure("account", "account@example.com", null),
    ]);

    const linked = rowFor("linked@example.com");
    expect(within(linked).getByRole("link", { name: "Open booking" })).toHaveAttribute(
      "href",
      "/bookings/booking-1",
    );
    expect(
      within(linked).getByRole("link", { name: "Open member" }).getAttribute("href"),
    ).toMatch(/\/member-1$/);

    const deleted = rowFor("deleted@example.com");
    expect(within(deleted).getByText("Booking no longer exists")).toBeVisible();
    expect(within(deleted).queryByRole("link", { name: "Open booking" })).toBeNull();

    // No link is ever built from the recipient address.
    expect(within(rowFor("account@example.com")).queryByRole("link")).toBeNull();
  });

  it("shows the true total, and a notice only when the list is a capped window", () => {
    const { unmount } = renderSection([failure("a", "a@example.com", null)], {
      totalExhaustedCount: 1,
      scanCapped: false,
    });
    expect(screen.getByText("Total exhausted").nextElementSibling).toHaveTextContent("1");
    expect(screen.queryByRole("note")).toBeNull();
    unmount();

    renderSection([failure("a", "a@example.com", null)], {
      totalExhaustedCount: 340,
      scannedCount: 200,
      scanCapped: true,
    });
    expect(screen.getByText("Total exhausted").nextElementSibling).toHaveTextContent("340");
    expect(screen.getByRole("note")).toHaveTextContent(
      "This list shows only the newest 200 of 340 exhausted failures.",
    );
  });

  it("documents provider exhaustion and security retirement before archive", () => {
    const guide = readFileSync(
      join(process.cwd(), "docs/guides/email-deliverability.md"),
      "utf8",
    );

    expect(guide).toContain("provider retry exhaustion");
    expect(guide).toContain("security retirement");
    expect(guide).toContain("**Failure reason**");
    expect(guide).toContain("regenerate a fresh email through the current booking workflow");
    expect(guide).toContain("before\n     choosing **Archive**");
    expect(guide).not.toContain(
      "sends that used every retry attempt and never\n     delivered",
    );
  });
});
