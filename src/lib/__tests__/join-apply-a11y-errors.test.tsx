// @vitest-environment jsdom

// F30 (#1889): WCAG 2.2 3.3.1 / 4.1.3 — validation and submission errors on
// the public join/apply form must be announced to assistive technology:
// invalid inputs carry aria-invalid + aria-describedby pointing at the error
// text, and the form-level error container is a role="alert" live region.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JoinApplyPageClient } from "@/app/(website)/join/apply/join-apply-page-client";
import type { ClubIdentity } from "@/config/club-identity-types";
import { expectRecoveryAlertToHoldFocus, expectToHoldFocus } from "@/lib/__tests__/helpers/focus";

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

function refuseWith(details: Record<string, string[]>) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: false,
    json: async () => ({ error: "Validation failed", details }),
  });
}

function summaryLinkNames() {
  return Array.from(screen.getByRole("alert").querySelectorAll("a")).map(
    (link) => link.textContent,
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

  // #4947 — a failed submit always lands on one focused form-level message.
  describe("the form-level error summary (#4947)", () => {
    it("names the one missing field, links to it and takes focus, without calling the API", async () => {
      render(<JoinApplyPageClient club={club} showHero={false} />);
      fillValidApplicant();
      fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "" } });

      submitForm();

      const alert = await screen.findByRole("alert");
      await waitFor(() => expect(alert.textContent).toContain("1 field needs attention."));
      expect(screen.getByRole("link", { name: "Date of birth is required" }).getAttribute("href")).toBe(
        "#applicantDateOfBirth",
      );
      await expectRecoveryAlertToHoldFocus(alert);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("lists several failures in form order, and each link focuses its input", async () => {
      render(<JoinApplyPageClient club={club} showHero={false} />);
      fillValidApplicant();
      fireEvent.change(screen.getByLabelText("First name"), { target: { value: "" } });
      fireEvent.change(screen.getByLabelText("Second nominator email"), { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "Add Household Member" }));
      fireEvent.change(document.getElementById("family-first-name-0") as HTMLElement, {
        target: { value: "Kiwi" },
      });
      fireEvent.change(document.getElementById("family-dob-0") as HTMLElement, {
        target: { value: "2015-03-01" },
      });

      submitForm();

      const alert = await screen.findByRole("alert");
      await waitFor(() => expect(alert.textContent).toContain("3 fields need attention."));
      expect(summaryLinkNames()).toEqual([
        "First name is required",
        "Household member 1 last name is required",
        "Second nominator email is required",
      ]);
      await expectRecoveryAlertToHoldFocus(alert);

      fireEvent.click(screen.getByRole("link", { name: "Household member 1 last name is required" }));
      await expectToHoldFocus(document.getElementById("family-last-name-0") as HTMLElement);
      fireEvent.click(screen.getByRole("link", { name: "Second nominator email is required" }));
      await expectToHoldFocus(screen.getByLabelText("Second nominator email"));
    });

    it("shows a phone refusal in the focused summary and marks the whole phone row invalid", async () => {
      refuseWith({ phoneNumber: ["String must contain at most 20 character(s)"] });
      render(<JoinApplyPageClient club={club} showHero={false} />);
      fillValidApplicant();

      submitForm();

      const alert = await screen.findByRole("alert");
      await waitFor(() =>
        expect(alert.textContent).toContain("Phone number: String must contain at most 20 character(s)"),
      );
      await expectRecoveryAlertToHoldFocus(alert);

      for (const label of ["Phone country code", "Phone area code", "Phone number"]) {
        const box = screen.getByLabelText(label);
        expect(box.getAttribute("aria-invalid")).toBe("true");
        const describedBy = (box.getAttribute("aria-describedby") ?? "").split(" ");
        const rowError = describedBy
          .map((id) => document.getElementById(id)?.textContent)
          .find((text) => text === "String must contain at most 20 character(s)");
        expect(rowError).toBeTruthy();
      }
    });

    it("shows a household refusal it cannot place on any input, unlinked", async () => {
      refuseWith({ familyMembers: ["Dependent 1 date of birth must be a real date"] });
      render(<JoinApplyPageClient club={club} showHero={false} />);
      fillValidApplicant();

      submitForm();

      const alert = await screen.findByRole("alert");
      await waitFor(() =>
        expect(alert.textContent).toContain("Dependent 1 date of birth must be a real date"),
      );
      expect(summaryLinkNames()).toEqual([]);
      await expectRecoveryAlertToHoldFocus(alert);
    });

    it("puts a field the page can show both on the field and in the summary", async () => {
      refuseWith({ nominator2Email: ["Choose a different second nominator"] });
      render(<JoinApplyPageClient club={club} showHero={false} />);
      fillValidApplicant();

      submitForm();

      const nominator2 = screen.getByLabelText("Second nominator email");
      await waitFor(() => expect(nominator2.getAttribute("aria-invalid")).toBe("true"));
      expect(document.getElementById("nominator2Email-error")?.textContent).toBe(
        "Choose a different second nominator",
      );
      const link = screen.getByRole("link", { name: /Choose a different second nominator/ });
      expect(link.getAttribute("href")).toBe("#nominator2Email");
      await expectRecoveryAlertToHoldFocus(screen.getByRole("alert"));
    });

    it("takes focus for a failure with no field details, and again for an identical second one", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("offline"));
      render(<JoinApplyPageClient club={club} showHero={false} />);
      fillValidApplicant();

      submitForm();
      const alert = await screen.findByRole("alert");
      await waitFor(() =>
        expect(alert.textContent).toBe("Something went wrong while submitting your application."),
      );
      await expectRecoveryAlertToHoldFocus(alert);

      screen.getByLabelText("First name").focus();
      submitForm();
      await expectRecoveryAlertToHoldFocus(alert);
    });

    it("never changes its text or takes focus while the person types", async () => {
      render(<JoinApplyPageClient club={club} showHero={false} />);

      submitForm();
      const alert = await screen.findByRole("alert");
      await waitFor(() => expect(alert.textContent).toContain("fields need attention."));
      await expectRecoveryAlertToHoldFocus(alert);
      const announced = alert.textContent;

      const firstName = screen.getByLabelText("First name");
      firstName.focus();
      fireEvent.change(firstName, { target: { value: "Tui" } });

      await waitFor(() => expect(firstName.getAttribute("aria-invalid")).toBe("false"));
      await expectToHoldFocus(firstName);
      expect(alert.textContent).toBe(announced);
    });
  });
});
