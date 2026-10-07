// @vitest-environment jsdom

import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it } from "vitest";
import { CronResultSummary } from "@/app/(admin)/admin/health/_components/shared";

describe("CronResultSummary — credit-sync drift indicator (#2501)", () => {
  it("surfaces the drift count and total amount when a run finds drift", () => {
    render(
      <CronResultSummary
        summary={{
          driftBookings: 2,
          totalDriftCents: 15000,
          scannedBookings: 5,
          completePass: true,
        }}
      />
    );
    // The dashboard indicator named in #2501's scope: a drift-finding SUCCESS
    // run must not read as an unqualified green — the count + amount are shown.
    expect(screen.queryByText(/2 credit drift/)).not.toBeNull();
    expect(screen.queryByText(/\$150\.00/)).not.toBeNull();
  });

  it("confirms 'Credits in sync' when a completed pass found no drift", () => {
    render(
      <CronResultSummary
        summary={{
          driftBookings: 0,
          totalDriftCents: 0,
          scannedBookings: 4,
          completePass: true,
        }}
      />
    );
    expect(screen.queryByText("Credits in sync")).not.toBeNull();
  });

  it("renders nothing extra for an unrelated summary with no drift fields", () => {
    const { container } = render(
      <CronResultSummary summary={{ processed: 3, failed: 0 }} />
    );
    expect(container.textContent).toBe("");
  });
});
