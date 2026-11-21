// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ClubFormatProvider } from "@/components/club-format-provider";

import { FoodOrderTotals, type FoodOrderYearTotalView } from "../food-order-totals";

/**
 * Fork #121 (owner, 13 Nov 2026): the totals panel keeps its headline and adds
 * totals by year; previous years sit in a disclosure that starts closed.
 */

const YEARS: FoodOrderYearTotalView[] = [
  { year: 2027, orderCount: 1, pricedCount: 1, priceTotalCents: 5000 },
  { year: 2026, orderCount: 3, pricedCount: 2, priceTotalCents: 12550 },
  { year: 2025, orderCount: 2, pricedCount: 2, priceTotalCents: 8000 },
  { year: 2024, orderCount: 1, pricedCount: 0, priceTotalCents: 0 },
];

function renderTotals(yearTotals: FoodOrderYearTotalView[]) {
  return render(
    <ClubFormatProvider currencyCode="NZD" locale="en-NZ">
      <FoodOrderTotals
        orderCount={7}
        pricedCount={5}
        priceTotalCents={25550}
        yearTotals={yearTotals}
        currentYear={2026}
        officerLabel="Food officer"
      />
    </ClubFormatProvider>,
  );
}

describe("FoodOrderTotals", () => {
  it("keeps the headline for the whole filter", () => {
    renderTotals(YEARS);
    const headline = screen.getByRole("status");
    expect(headline.textContent).toContain("7 orders");
    expect(headline.textContent).toContain("255.50");
    expect(headline.textContent).toContain("(5 of 7 priced)");
  });

  it("shows this year and later openly, and earlier years collapsed until opened", () => {
    const { container } = renderTotals(YEARS);
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(screen.getByText("Previous years (2)")).toBeTruthy();

    const open = container.querySelector("section > ul");
    expect(open?.textContent).toContain("2027");
    expect(open?.textContent).toContain("2026");
    expect(open?.textContent).toContain("(2 of 3 priced)");
    expect(open?.textContent).not.toContain("2025");

    const inside = details!.querySelector("ul");
    expect(inside?.textContent).toContain("2025");
    expect(inside?.textContent).toContain("2024");
    // Newest first inside the disclosure too.
    expect(inside!.textContent!.indexOf("2025")).toBeLessThan(inside!.textContent!.indexOf("2024"));

    fireEvent.click(screen.getByText("Previous years (2)"));
    expect(details!.open).toBe(true);
  });

  it("has no expander when there are no previous years", () => {
    const { container } = renderTotals(YEARS.filter((total) => total.year >= 2026));
    expect(container.querySelector("details")).toBeNull();
    expect(screen.queryByText(/Previous years/)).toBeNull();
  });

  it("shows no By year section when nothing matches", () => {
    renderTotals([]);
    expect(screen.queryByText("By year")).toBeNull();
  });
});
