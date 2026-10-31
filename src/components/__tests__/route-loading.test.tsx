// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import AdminLoading from "@/app/(admin)/loading";
import LodgeLoading from "@/app/(lodge)/loading";
import FinanceDashboardLoading from "@/app/(finance)/finance/loading";
import { RouteLoading } from "@/components/route-loading";

/**
 * The shared loading shell (#4467): a polite live status region with a visually
 * hidden label, and skeleton blocks hidden from assistive technology. Rendered
 * through the group-level loading files as well as directly, so a group that
 * swaps the shell for a bare skeleton fails here as well as in the census.
 */
describe("RouteLoading (#4467)", () => {
  afterEach(cleanup);

  it("is a polite status region announcing its label, with the skeleton hidden", () => {
    const { container } = render(<RouteLoading label="Loading members…" />);

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    // aria-busy would tell a screen reader to hold the announcement.
    expect(status.hasAttribute("aria-busy")).toBe(false);
    expect(status.textContent).toBe("Loading members…");

    const label = screen.getByText("Loading members…");
    expect(label.className).toContain("sr-only");

    const skeleton = container.querySelector('[aria-hidden="true"]');
    expect(skeleton).not.toBeNull();
    expect(skeleton?.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("defaults its label and renders custom skeleton children in place of the generic one", () => {
    render(
      <RouteLoading className="space-y-6">
        <div data-testid="custom-skeleton" />
      </RouteLoading>,
    );

    expect(screen.getByRole("status").textContent).toBe("Loading…");
    expect(screen.getByTestId("custom-skeleton")).toBeTruthy();
  });

  for (const [name, Loading] of [
    ["(admin)", AdminLoading],
    ["(lodge)", LodgeLoading],
    ["(finance)/finance", FinanceDashboardLoading],
  ] as const) {
    it(`${name}/loading.tsx renders the shell`, () => {
      render(<Loading />);

      expect(screen.getByRole("status").textContent).toMatch(/^Loading/);
    });
  }
});
