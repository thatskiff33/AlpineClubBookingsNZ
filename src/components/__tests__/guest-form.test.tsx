// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuestForm } from "@/components/guest-form";

describe("GuestForm", () => {
  beforeEach(() => {
    global.fetch = vi.fn(
      async () => new Response("{}", { status: 500 }),
    ) as unknown as typeof fetch;
  });

  it("labels added rows as non-member guests and dims linked-member age categories", () => {
    const onGuestsChange = vi.fn();
    const { container } = render(
      <GuestForm
        guests={[
          {
            firstName: "Ari",
            lastName: "Family",
            ageTier: "CHILD",
            isMember: true,
            memberId: "member-child",
          },
        ]}
        onGuestsChange={onGuestsChange}
        maxGuests={6}
      />,
    );

    expect(
      screen.getByRole("button", { name: "+ Add Non-Member Guest" }),
    ).toBeTruthy();

    const ageCategory = container.querySelector("select");
    expect(ageCategory).not.toBeNull();
    expect((ageCategory as HTMLSelectElement).disabled).toBe(true);
    expect(ageCategory?.className).toContain("disabled:cursor-not-allowed");
    expect(ageCategory?.className).toContain("disabled:opacity-50");
  });

  /**
   * #2930 fix round — `maxGuests` is nullable because a lodge with no configured
   * capacity resolves to 0 beds by design, and a ceiling of zero disabled every
   * add-guest control at zero guests while the wizard still needed one guest to
   * continue. Null is "no client ceiling"; the server decides.
   */
  it("imposes no ceiling, and states none, when maxGuests is null", () => {
    render(
      <GuestForm
        guests={[
          { firstName: "Ari", lastName: "Guest", ageTier: "ADULT", isMember: false },
        ]}
        onGuestsChange={vi.fn()}
        maxGuests={null}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "+ Add Non-Member Guest" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    // "Guests (1/0 max)" would be a lie about the lodge as well as a dead end.
    expect(screen.getByRole("heading", { name: /Guests/ }).textContent).toBe(
      "Guests (1)",
    );
  });

  it("still caps the party at a real maxGuests", () => {
    render(
      <GuestForm
        guests={[
          { firstName: "Ari", lastName: "Guest", ageTier: "ADULT", isMember: false },
        ]}
        onGuestsChange={vi.fn()}
        maxGuests={1}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "+ Add Non-Member Guest" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByRole("heading", { name: /Guests/ }).textContent).toBe(
      "Guests (1/1 max)",
    );
  });
});
