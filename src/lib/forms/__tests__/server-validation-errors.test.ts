import { describe, expect, it, vi } from "vitest";

import { applyServerValidationErrors } from "@/lib/forms/server-validation-errors";

// #4467: the route's refusal is read through `readValidationDetails`, the
// reader `formatValidationErrorResponse` uses, so both shapes the routes send
// reach the form and nothing else does.

function fakeForm(values: Record<string, unknown>) {
  return { setError: vi.fn(), getValues: vi.fn(() => values) };
}

describe("applyServerValidationErrors", () => {
  it("puts the full flatten() shape's field messages on their fields", () => {
    const form = fakeForm({ name: "", contactEmail: "" });
    const applied = applyServerValidationErrors(form, {
      error: "Invalid input",
      details: {
        formErrors: [],
        fieldErrors: { contactEmail: ["Enter an address", "Too long"] },
      },
    });

    expect(applied).toBe(true);
    expect(form.setError.mock.calls).toEqual([
      ["contactEmail", { type: "server", message: "Enter an address Too long" }],
    ]);
  });

  it("reads the member routes' bare fieldErrors shape too", () => {
    const form = fakeForm({ email: "" });
    expect(
      applyServerValidationErrors(form, {
        error: "Validation failed",
        details: { email: ["Invalid email address"] },
      }),
    ).toBe(true);
    expect(form.setError).toHaveBeenCalledWith("email", {
      type: "server",
      message: "Invalid email address",
    });
  });

  it("sends form-level messages and unknown fields to root.server, labelled", () => {
    const form = fakeForm({ name: "" });
    applyServerValidationErrors(form, {
      details: {
        formErrors: ['Unrecognized key: "colour"'],
        fieldErrors: { sortOrder: ["Too big"] },
      },
    });

    expect(form.setError.mock.calls).toEqual([
      [
        "root.server",
        { type: "server", message: 'Unrecognized key: "colour" Sort order: Too big' },
      ],
    ]);
  });

  it.each([
    ["a 403", { error: "Forbidden" }],
    ["an HTML page", "<html>Bad gateway</html>"],
    ["null", null],
    ["details with only blank messages", { details: { fieldErrors: { name: ["  "] } } }],
    ["details that are not an object", { details: "nope" }],
  ])("sets nothing and says so for %s", (_label, body) => {
    const form = fakeForm({ name: "" });
    expect(applyServerValidationErrors(form, body)).toBe(false);
    expect(form.setError).not.toHaveBeenCalled();
  });
});
