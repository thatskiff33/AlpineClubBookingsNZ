// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JoiningFeePreviewHint } from "@/components/admin/joining-fee-preview";

// #3325: the hint used to format its amount with its own hard-coded
// `Intl.NumberFormat("en-NZ", { currency: "NZD" })`; it now renders through the
// shared `formatCents`, which reads the club's configured locale and currency.
// Literal pin under the default configuration — grouped, two decimals — so a
// hand-rolled or hard-coded formatter ("$1234.56", "NZ$1,234.56") fails here.
describe("JoiningFeePreviewHint (#3325)", () => {
  it("renders the default joining fee through the club's configured currency formatter", () => {
    render(
      <JoiningFeePreviewHint
        state={{
          loading: false,
          loaded: true,
          error: null,
          preview: {
            defaultAmountCents: 123456,
            defaultNarration: "Joining fee",
            exempt: false,
            effectiveFrom: "2026-01-01",
            source: "SCHEDULE",
          },
        }}
      />,
    );
    expect(screen.getByText("$1,234.56")).toBeInTheDocument();
  });
});
