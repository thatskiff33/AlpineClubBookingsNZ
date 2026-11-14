// @vitest-environment jsdom

// F30 (#1889): WCAG 2.2 3.3.1 / 4.1.3 — validation and submission errors on
// the public join/apply form must be announced to assistive technology:
// invalid inputs carry aria-invalid + aria-describedby pointing at the error
// text, and the form-level error container is a role="alert" live region.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JOIN_APPLY_INPUT_IDS } from "@/app/(website)/join/apply/join-apply-input-ids";
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

/** The nth household member's input, found by the prefix its id shares. */
function familyInput(field: "first-name" | "last-name" | "dob", index: number) {
  return document.querySelectorAll<HTMLElement>(`input[id^="family-${field}-"]`)[index];
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
    await waitFor(() => expect(alert.textContent).toContain("Applications are closed right now."));
  });

  it("puts the first of a field's messages on the field, and all of them in the summary (#4580, #4947)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({
        error: "Please provide two different nominators",
        details: { nominator2Email: ["Choose a different second nominator", "A second message"] },
      }),
    });

    render(<JoinApplyPageClient club={club} showHero={false} />);

    fillValidApplicant();
    submitForm();

    const nominator2 = screen.getByLabelText("Second nominator email");
    await waitFor(() => expect(nominator2.getAttribute("aria-invalid")).toBe("true"));
    // The field's own line shows the first message only.
    expect(document.getElementById("nominator2Email-error")?.textContent).toBe(
      "Choose a different second nominator",
    );
    // The summary joins both, so nothing the server said is lost.
    expect(summaryLinkNames()).toEqual([
      "Nominator 2 email: Choose a different second nominator; A second message",
    ]);
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
    await waitFor(() => expect(alert.textContent).toContain("Something about the nominators"));
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
      fireEvent.change(familyInput("first-name", 0), { target: { value: "Kiwi" } });
      fireEvent.change(familyInput("dob", 0), { target: { value: "2015-03-01" } });

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
      await expectToHoldFocus(familyInput("last-name", 0));
      fireEvent.click(screen.getByRole("link", { name: "Second nominator email is required" }));
      await expectToHoldFocus(screen.getByLabelText("Second nominator email"));
    });

    it("shows a phone refusal in the focused summary and marks the whole phone row invalid", async () => {
      refuseWith({ phoneNumber: ["Too big: expected string to have <=20 characters"] });
      render(<JoinApplyPageClient club={club} showHero={false} />);
      fillValidApplicant();

      submitForm();

      const alert = await screen.findByRole("alert");
      await waitFor(() =>
        expect(alert.textContent).toContain("Phone number: Too big: expected string to have <=20 characters"),
      );
      await expectRecoveryAlertToHoldFocus(alert);

      for (const label of ["Phone country code", "Phone area code", "Phone number"]) {
        const box = screen.getByLabelText(label);
        expect(box.getAttribute("aria-invalid")).toBe("true");
        const describedBy = (box.getAttribute("aria-describedby") ?? "").split(" ");
        const rowError = describedBy
          .map((id) => document.getElementById(id)?.textContent)
          .find((text) => text === "Phone number: Too big: expected string to have <=20 characters");
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

    it("lists an address refusal without a link, since a closed address section has no input", async () => {
      refuseWith({ postalAddressLine1: ["Too big: expected string to have <=200 characters"] });
      render(<JoinApplyPageClient club={club} showHero={false} />);
      fillValidApplicant();

      submitForm();

      const alert = await screen.findByRole("alert");
      await waitFor(() =>
        expect(alert.textContent).toContain(
          "Postal address line 1: Too big: expected string to have <=200 characters",
        ),
      );
      expect(summaryLinkNames()).toEqual([]);
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

    it("takes focus back for a second, identical browser-side failure", async () => {
      render(<JoinApplyPageClient club={club} showHero={false} />);

      submitForm();
      const alert = await screen.findByRole("alert");
      await waitFor(() => expect(alert.textContent).toContain("fields need attention."));
      await expectRecoveryAlertToHoldFocus(alert);
      const announced = alert.textContent;

      screen.getByLabelText("Email").focus();
      submitForm();

      await expectRecoveryAlertToHoldFocus(alert);
      expect(alert.textContent).toBe(announced);
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

    it("gives each link a name of its own when three emails fail the same check", async () => {
      render(<JoinApplyPageClient club={club} showHero={false} />);
      fillValidApplicant();
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "tui@example" } });
      fireEvent.change(screen.getByLabelText("First nominator email"), { target: { value: "nom1@x" } });
      fireEvent.change(screen.getByLabelText("Second nominator email"), { target: { value: "nom2@x" } });

      submitForm();

      const alert = await screen.findByRole("alert");
      await waitFor(() => expect(alert.textContent).toContain("3 fields need attention."));
      // Read away from the fields, "Enter a valid email address" three times says nothing.
      expect(summaryLinkNames()).toEqual([
        "Enter a valid applicant email address",
        "Enter a valid first nominator email address",
        "Enter a valid second nominator email address",
      ]);
    });

    it("renders an input for every id a summary link can name", () => {
      render(<JoinApplyPageClient club={club} showHero={false} />);

      for (const id of Object.values(JOIN_APPLY_INPUT_IDS)) {
        expect(document.getElementById(id), id).toBeInstanceOf(HTMLInputElement);
      }
    });

    it("lists a form-level server message without a link, and counts only the fields", async () => {
      refuseWith({
        formErrors: ["The form as a whole is not acceptable"],
        fieldErrors: { nominator2Email: ["Choose a different second nominator"] },
      } as unknown as Record<string, string[]>);
      render(<JoinApplyPageClient club={club} showHero={false} />);
      fillValidApplicant();

      submitForm();

      const alert = await screen.findByRole("alert");
      await waitFor(() => expect(alert.textContent).toContain("1 field needs attention."));
      expect(alert.textContent).toContain("The form as a whole is not acceptable");
      expect(summaryLinkNames()).toEqual(["Nominator 2 email: Choose a different second nominator"]);
      await expectRecoveryAlertToHoldFocus(alert);
    });

    it("shows a refusal that only has form-level messages, instead of dropping them", async () => {
      refuseWith({ formErrors: ["The form as a whole is not acceptable"], fieldErrors: {} } as unknown as Record<
        string,
        string[]
      >);
      render(<JoinApplyPageClient club={club} showHero={false} />);
      fillValidApplicant();

      submitForm();

      const alert = await screen.findByRole("alert");
      await waitFor(() => expect(alert.textContent).toContain("The form as a whole is not acceptable"));
      expect(alert.textContent).toContain("Your application could not be submitted.");
      expect(summaryLinkNames()).toEqual([]);
      await expectRecoveryAlertToHoldFocus(alert);
    });

    it("keeps a household link on the same person after another member is removed", async () => {
      render(<JoinApplyPageClient club={club} showHero={false} />);
      fillValidApplicant();
      for (let member = 0; member < 3; member++) {
        fireEvent.click(screen.getByRole("button", { name: "Add Household Member" }));
        fireEvent.change(familyInput("first-name", member), { target: { value: `Member ${member + 1}` } });
        fireEvent.change(familyInput("dob", member), { target: { value: "2015-03-01" } });
      }
      const [, second, third] = [0, 1, 2].map((member) => familyInput("last-name", member));

      submitForm();
      const alert = await screen.findByRole("alert");
      await waitFor(() => expect(alert.textContent).toContain("3 fields need attention."));

      // Remove member 1: member 2 is now the first on the page, member 3 the second.
      fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
      expect(familyInput("last-name", 0)).toBe(second);

      // The link for member 2 lands on member 2, not on whoever sits in slot 2 now.
      fireEvent.click(screen.getByRole("link", { name: "Household member 2 last name is required" }));
      await expectToHoldFocus(second);
      fireEvent.click(screen.getByRole("link", { name: "Household member 3 last name is required" }));
      await expectToHoldFocus(third);

      // The link for the removed member finds nothing, and moves focus nowhere.
      fireEvent.click(screen.getByRole("link", { name: "Household member 1 last name is required" }));
      await expectToHoldFocus(third);
    });

    it("focuses the input in its own form when the form is embedded twice", async () => {
      render(
        <>
          <JoinApplyPageClient club={club} showHero={false} />
          <JoinApplyPageClient club={club} showHero={false} />
        </>,
      );
      const [firstForm, secondForm] = Array.from(document.querySelectorAll("form"));

      fireEvent.click(within(secondForm).getByRole("button", { name: /submit membership application/i }));
      const alert = await within(secondForm).findByRole("alert");
      await waitFor(() => expect(alert.textContent).toContain("fields need attention."));

      fireEvent.click(within(secondForm).getByRole("link", { name: "First name is required" }));

      await expectToHoldFocus(secondForm.querySelector("#applicantFirstName") as HTMLElement);
      expect(firstForm.contains(document.activeElement)).toBe(false);
    });
  });
});
