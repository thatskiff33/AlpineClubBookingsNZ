// @vitest-environment jsdom

// #3372 (owner, 7 Oct 2026): the "Refunds owed" and "Credits owed" figures
// beside every Net Collected figure. One component, so the labels, the note and
// how a screen reader hears them cannot differ between surfaces.
import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RefundsAndCreditsOwedList } from "@/components/admin/refunds-and-credits-owed";
import {
  CREDITS_OWED_LABEL,
  REFUNDS_AND_CREDITS_OWED_NOTE,
  REFUNDS_OWED_LABEL,
} from "@/lib/refunds-and-credits-owed-shared";

const owed = { refundsOwedCents: 16_500, creditsOwedCents: 8_500 };
const formatCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;

describe("RefundsAndCreditsOwedList", () => {
  it("renders the exact labels, amounts and note", () => {
    render(<RefundsAndCreditsOwedList owed={owed} formatCents={formatCents} />);
    const list = screen.getByTestId("refunds-and-credits-owed");

    expect(REFUNDS_OWED_LABEL).toBe("Refunds owed");
    expect(CREDITS_OWED_LABEL).toBe("Credits owed");
    const terms = within(list).getAllByRole("term").map((term) => term.textContent);
    const values = within(list).getAllByRole("definition").map((value) => value.textContent);
    expect(terms).toEqual(["Refunds owed", "Credits owed"]);
    expect(values).toEqual(["$165.00", "$85.00"]);
    expect(list).toHaveTextContent(
      "As at today, across the club: not limited to any dates or filters.",
    );
    expect(REFUNDS_AND_CREDITS_OWED_NOTE).toBe(
      "As at today, across the club: not limited to any dates or filters.",
    );
  });

  it("describes the figures by the note, so a screen reader hears they are not the page's range", () => {
    const { container } = render(
      <RefundsAndCreditsOwedList owed={owed} formatCents={formatCents} />,
    );
    const dl = container.querySelector("dl");
    const describedBy = dl?.getAttribute("aria-describedby");

    expect(describedBy).toBeTruthy();
    expect(container.querySelector(`[id="${describedBy}"]`)?.textContent).toBe(
      REFUNDS_AND_CREDITS_OWED_NOTE,
    );
  });

  it("stacks the figures on a narrow screen when asked, side by side from sm up", () => {
    const stacked = renderToStaticMarkup(
      <RefundsAndCreditsOwedList owed={owed} formatCents={formatCents} stacked />,
    );
    const flowing = renderToStaticMarkup(
      <RefundsAndCreditsOwedList owed={owed} formatCents={formatCents} />,
    );

    expect(stacked).toMatch(/<dl[^>]*class="[^"]*\bflex-col\b[^"]*\bsm:flex-row\b/);
    expect(flowing).not.toContain("flex-col");
  });
});
