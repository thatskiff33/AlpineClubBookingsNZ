// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Radio } from "@/components/ui/radio";

function AccountChoice() {
  const [account, setAccount] = useState<"own" | "goodwill" | null>(null);
  return (
    <fieldset>
      <legend>Xero account</legend>
      <label htmlFor="account-own">
        <Radio
          id="account-own"
          name="account"
          value="own"
          checked={account === "own"}
          onChange={() => setAccount("own")}
        />
        Member&apos;s own money
      </label>
      <label htmlFor="account-goodwill">
        <Radio
          id="account-goodwill"
          name="account"
          value="goodwill"
          checked={account === "goodwill"}
          onChange={() => setAccount("goodwill")}
        />
        Goodwill
      </label>
    </fieldset>
  );
}

afterEach(cleanup);

describe("Radio", () => {
  it("is a native radio, so a label names it and only one in the group is chosen", () => {
    render(<AccountChoice />);
    const own = screen.getByRole("radio", { name: "Member's own money" });
    const goodwill = screen.getByRole("radio", { name: "Goodwill" });

    expect(own).toHaveAttribute("type", "radio");
    expect(own).toHaveAttribute("name", "account");
    expect(own).not.toBeChecked();
    expect(goodwill).not.toBeChecked();

    fireEvent.click(own);
    expect(own).toBeChecked();
    expect(goodwill).not.toBeChecked();

    fireEvent.click(goodwill);
    expect(own).not.toBeChecked();
    expect(goodwill).toBeChecked();
  });
});
