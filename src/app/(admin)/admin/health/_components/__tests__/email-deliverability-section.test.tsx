// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  ADMIN_VIEW_ONLY_ACTION_REASON:
    "Your admin role can view this area but cannot make changes.",
  useAdminAreaEditAccess: () => true,
}));

import { EmailDeliverabilitySection } from "@/app/(admin)/admin/health/_components/email-deliverability-section";
import type { HealthData } from "@/app/(admin)/admin/health/_components/types";

const SECURITY_RETIREMENT_REASON =
  "Not retried: this booking email predates retry-time recipient authorization context (#2362). Re-send it by hand if the recipient still needs it.";
const PROVIDER_REASON =
  'SMTP rejected <img src=x onerror="window.pwned=true">';

function failure(
  id: string,
  to: string,
  errorMessage: string | null,
): HealthData["emailFailures"]["failures"][number] {
  return {
    id,
    to,
    subject: "Booking confirmation",
    templateName: "booking-confirmation",
    attempts: 3,
    lastAttemptAt: "2026-08-01T01:00:00.000Z",
    errorMessage,
    createdAt: "2026-08-01T00:00:00.000Z",
    reviewedAt: null,
    reviewedById: null,
    reviewNote: null,
  };
}

describe("EmailDeliverabilitySection exhausted failures", () => {
  it("labels and renders authoritative security and provider reasons as escaped text", () => {
    const { container } = render(
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
            activeCount: 2,
            reviewedCount: 0,
            scannedCount: 2,
            maxAttempts: 3,
          },
          failures: [
            failure("legacy", "legacy@example.com", SECURITY_RETIREMENT_REASON),
            failure("provider", "provider@example.com", PROVIDER_REASON),
          ],
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
        onRefresh={vi.fn()}
        onError={vi.fn()}
      />,
    );

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
