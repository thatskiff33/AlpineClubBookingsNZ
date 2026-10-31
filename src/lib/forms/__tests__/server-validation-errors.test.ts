import { describe, expect, it, vi } from "vitest";

import { applyServerValidationErrors } from "@/lib/forms/server-validation-errors";

// #4467: the route's refusal is read through `readValidationDetails`, the one
// reader `formatValidationErrorResponse` also uses, and only when it IS a
// validation refusal: a 400 or 422 whose `details` is zod's flatten() shape.

type Form = Parameters<typeof applyServerValidationErrors<Record<string, unknown>>>[0];

function fakeForm(values: Record<string, unknown>) {
  const setError = vi.fn<Form["setError"]>();
  // `getValues` is overloaded; the helper only ever calls the no-argument form.
  const getValues = vi.fn(() => values) as unknown as Form["getValues"];
  return { setError, getValues };
}

describe("applyServerValidationErrors", () => {
  it("puts the full flatten() shape's field messages on their fields", () => {
    const form = fakeForm({ name: "", contactEmail: "" });
    const applied = applyServerValidationErrors(form, 400, {
      error: "Invalid input",
      details: {
        formErrors: [],
        fieldErrors: { contactEmail: ["Enter an address", "Too long"] },
      },
    });

    expect(applied).toBe(true);
    // The same "; " join `formatValidationErrorResponse` uses.
    expect(form.setError.mock.calls).toEqual([
      ["contactEmail", { type: "server", message: "Enter an address; Too long" }],
    ]);
  });

  it("reads the member routes' bare fieldErrors shape on a 422", () => {
    const form = fakeForm({ email: "" });
    expect(
      applyServerValidationErrors(form, 422, {
        error: "Validation failed",
        details: { email: ["Invalid email address"] },
      }),
    ).toBe(true);
    expect(form.setError).toHaveBeenCalledWith("email", {
      type: "server",
      message: "Invalid email address",
    });
  });

  it("sends form-level messages and unknown fields to root.server, labelled as the formatter labels them", () => {
    const form = fakeForm({ name: "" });
    applyServerValidationErrors(form, 400, {
      details: {
        formErrors: ['Unrecognized key: "colour"'],
        fieldErrors: { sortOrder: ["Too big"], dateOfBirth: ["Invalid date"] },
      },
    });

    expect(form.setError.mock.calls).toEqual([
      [
        "root.server",
        {
          type: "server",
          message: 'Unrecognized key: "colour"; Sort order: Too big; Date of birth: Invalid date',
        },
      ],
    ]);
  });

  const zodBody = { error: "Invalid input", details: { fieldErrors: { name: ["Bad"] } } };

  it.each([401, 403, 404, 409, 500])("maps nothing on a %i, even with zod details", (status) => {
    const form = fakeForm({ name: "" });
    expect(applyServerValidationErrors(form, status, zodBody)).toBe(false);
    expect(form.setError).not.toHaveBeenCalled();
  });

  it.each([
    ["no details", { error: "At least one committee role field is required" }],
    ["an HTML page", "<html>Bad gateway</html>"],
    ["null", null],
    ["details with only blank messages", { details: { fieldErrors: { name: ["  "] } } }],
    ["details that are not an object", { details: "nope" }],
    ["a list of refused rows", { error: "Some mappings were refused", details: ["Row 2: unknown code"] }],
    ["a provider payload", { error: "Xero refused", details: { code: 7, name: "ValidationException" } }],
    ["a full shape with a stray key", { details: { fieldErrors: { name: ["Bad"] }, issues: [] } }],
    ["a field map with a non-string message", { details: { name: ["Bad", 3] } }],
  ])("sets nothing and says so for a 400 with %s", (_label, body) => {
    const form = fakeForm({ name: "" });
    expect(applyServerValidationErrors(form, 400, body)).toBe(false);
    expect(form.setError).not.toHaveBeenCalled();
  });
});
