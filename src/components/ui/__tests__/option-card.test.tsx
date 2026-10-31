// @vitest-environment jsdom

// #4563 — the choice card shows WHICH option is chosen without relying on
// colour: `aria-pressed` for assistive tech, a visible "Selected" label for
// everyone, and a named group around the set.

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CreditCard, Landmark } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";

import { OptionCard, OptionCardGroup } from "@/components/ui/option-card";

function PaymentChoice() {
  const [method, setMethod] = useState<"card" | "bank">("card");
  return (
    <OptionCardGroup label="Payment method">
      <OptionCard
        selected={method === "card"}
        onSelect={() => setMethod("card")}
        icon={CreditCard}
        title="Card"
      >
        Pay now.
      </OptionCard>
      <OptionCard
        selected={method === "bank"}
        onSelect={() => setMethod("bank")}
        icon={Landmark}
        title="Internet Banking"
      >
        Receive an invoice.
      </OptionCard>
    </OptionCardGroup>
  );
}

afterEach(cleanup);

describe("OptionCard (#4563)", () => {
  it("reports the chosen option through aria-pressed and a visible Selected label", () => {
    render(<PaymentChoice />);
    const card = screen.getByRole("button", { name: /^Card/ });
    const bank = screen.getByRole("button", { name: /^Internet Banking/ });

    expect(card).toHaveAttribute("aria-pressed", "true");
    expect(bank).toHaveAttribute("aria-pressed", "false");
    expect(within(card).getByText("Selected")).toBeVisible();
    expect(within(bank).queryByText("Selected")).toBeNull();

    fireEvent.click(bank);

    expect(card).toHaveAttribute("aria-pressed", "false");
    expect(bank).toHaveAttribute("aria-pressed", "true");
    expect(within(bank).getByText("Selected")).toBeVisible();
    expect(within(card).queryByText("Selected")).toBeNull();
    // The state is announced once, by aria-pressed; the visible word stays
    // out of the name so a change of choice does not re-read both names.
    expect(bank).not.toHaveAccessibleName(/Selected/);
    expect(bank).toHaveClass("border-info");
  });

  it("is a native, focusable button, so Enter and Space choose it with no key handler", () => {
    render(<PaymentChoice />);
    const bank = screen.getByRole("button", { name: /^Internet Banking/ });

    // jsdom does not turn a key press into a click; a browser does for a native
    // `<button>`, which is why the card is one rather than a div with a role.
    expect(bank.tagName).toBe("BUTTON");
    expect(bank).toHaveAttribute("type", "button");
    expect(bank).not.toHaveAttribute("tabindex");
    bank.focus();
    expect(bank).toHaveFocus();
  });

  it("names the set as a group after its visible heading", () => {
    render(<PaymentChoice />);
    const group = screen.getByRole("group", { name: "Payment method" });
    expect(within(group).getAllByRole("button")).toHaveLength(2);
  });

  it("hides its icons from assistive tech", () => {
    render(<PaymentChoice />);
    const card = screen.getByRole("button", { name: /^Card/ });
    for (const svg of card.querySelectorAll("svg")) {
      expect(svg).toHaveAttribute("aria-hidden", "true");
    }
  });
});
