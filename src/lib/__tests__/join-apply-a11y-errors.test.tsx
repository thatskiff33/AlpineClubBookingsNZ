// @vitest-environment jsdom

// F30 (#1889): WCAG 2.2 3.3.1 / 4.1.3 — validation and submission errors on
// the public join/apply form must be announced to assistive technology:
// invalid inputs carry aria-invalid + aria-describedby pointing at the error
// text, and the form-level error container is a role="alert" live region.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JoinApplyPageClient } from "@/app/(website)/join/apply/join-apply-page-client";
import type { ClubIdentity } from "@/config/club-identity-types";

// Address fields are not under test and pull in the autocomplete widget;
// stub them so the form renders lean in jsdom.
vi.mock("@/components/member-address-fields", () => ({
  MemberAddressFields: () => <div data-testid="address-fields" />,
}));

const club = { name: "Example Club" } as unknown as ClubIdentity;

function submitForm() {
  fireEvent.click(
    screen.getByRole("button", { name: /submit membership application/i }),
  );
}

function fillValidApplicant() {
  fireEvent.change(screen.getByLabelText("First name"), {
    target: { value: "Tui" },
  });
  fireEvent.change(screen.getByLabelText("Last name"), {
    target: { value: "Kea" },
  });
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "tui@example.org" },
  });
  fireEvent.change(screen.getByLabelText("Date of birth"), {
    target: { value: "1990-01-15" },
  });
  fireEvent.change(screen.getByLabelText("First nominator email"), {
    target: { value: "nom1@example.org" },
  });
  fireEvent.change(screen.getByLabelText("Second nominator email"), {
    target: { value: "nom2@example.org" },
  });
}

describe("JoinApplyPageClient error accessibility (F30, #1889)", () => {
  beforeEach(() => {
    global.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks invalid fields with aria-invalid and aria-describedby after a failed submit", async () => {
    render(<JoinApplyPageClient club={club} showHero={false} />);

    submitForm();

    const firstName = screen.getByLabelText("First name");
    await waitFor(() =>
      expect(firstName.getAttribute("aria-invalid")).toBe("true"),
    );

    const describedBy = firstName.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const errorEl = document.getElementById(describedBy as string);
    expect(errorEl).toBeTruthy();
    expect(errorEl?.textContent).toBe("First name is required");

    const nominator2 = screen.getByLabelText("Second nominator email");
    expect(nominator2.getAttribute("aria-invalid")).toBe("true");
    const nominator2ErrorId = nominator2.getAttribute("aria-describedby");
    expect(nominator2ErrorId).toBeTruthy();
    expect(
      document.getElementById(nominator2ErrorId as string)?.textContent,
    ).toBe("Second nominator email is required");

    // Validation never ran a network call.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("clears aria-invalid and aria-describedby once the field is corrected", async () => {
    render(<JoinApplyPageClient club={club} showHero={false} />);

    submitForm();

    const firstName = screen.getByLabelText("First name");
    await waitFor(() =>
      expect(firstName.getAttribute("aria-invalid")).toBe("true"),
    );

    fireEvent.change(firstName, { target: { value: "Tui" } });

    await waitFor(() =>
      expect(firstName.getAttribute("aria-invalid")).toBe("false"),
    );
    expect(firstName.getAttribute("aria-describedby")).toBeNull();
  });

  it("announces form-level submission errors via a role=alert live region", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Applications are closed right now." }),
    });

    render(<JoinApplyPageClient club={club} showHero={false} />);

    fillValidApplicant();
    submitForm();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Applications are closed right now.");
  });

  it("puts the route's field details on the field, read through the shared reader (#4580)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({
        error: "Please provide two different nominators",
        details: { nominator2Email: ["Choose a different second nominator", "ignored second message"] },
      }),
    });

    render(<JoinApplyPageClient club={club} showHero={false} />);

    fillValidApplicant();
    submitForm();

    const nominator2 = screen.getByLabelText("Second nominator email");
    await waitFor(() => expect(nominator2.getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByText("Choose a different second nominator")).toBeTruthy();
    expect(screen.queryByText("ignored second message")).toBeNull();
  });

  it("shows the route's own sentence when the details are not a field map (#4580)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Something about the nominators", details: ["not", "a", "map"] }),
    });

    render(<JoinApplyPageClient club={club} showHero={false} />);

    fillValidApplicant();
    submitForm();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Something about the nominators");
  });
});
