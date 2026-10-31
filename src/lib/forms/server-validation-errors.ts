import type {
  FieldPath,
  FieldValues,
  UseFormGetValues,
  UseFormSetError,
} from "react-hook-form";

import {
  humanizeFieldKey,
  readValidationDetails,
} from "@/lib/format-validation-errors";

/**
 * Put an API route's validation refusal back on the form that sent it (#4467).
 *
 * The routes answer a body their zod schema refuses with
 * `{ error, details: parsed.error.flatten() }` (or, on a few member routes,
 * `details: parsed.error.flatten().fieldErrors`). This reads that one shape
 * through `readValidationDetails`, the same reader the admin member dialogs'
 * message list uses, rather than a second parser:
 *
 * - a message for a field the form has goes on that field (`type: "server"`),
 *   so it shows inline and in `FormErrorSummary`;
 * - a form-level message, or one for a key the form does not render, goes on
 *   `root.server`, which the summary shows without a link.
 *
 * Call it inside the `handleSubmit` callback, before it returns: the summary
 * takes focus when the submit completes, and errors set later would not move
 * it. It returns whether anything was set; when nothing was (a 403, a 500, a
 * body with no `details`), the caller shows its usual request-level message.
 */
export function applyServerValidationErrors<TFieldValues extends FieldValues>(
  form: {
    setError: UseFormSetError<TFieldValues>;
    getValues: UseFormGetValues<TFieldValues>;
  },
  body: unknown,
): boolean {
  const details = readValidationDetails(body);
  if (!details) return false;

  const fields = new Set(Object.keys(form.getValues() ?? {}));
  const formLevel = [...details.formErrors];

  for (const [field, messages] of details.fieldErrors) {
    if (fields.has(field)) {
      form.setError(field as FieldPath<TFieldValues>, {
        type: "server",
        message: messages.join(" "),
      });
    } else {
      formLevel.push(`${humanizeFieldKey(field)}: ${messages.join(" ")}`);
    }
  }

  if (formLevel.length > 0) {
    form.setError("root.server", {
      type: "server",
      message: formLevel.join(" "),
    });
  }

  return details.fieldErrors.length > 0 || formLevel.length > 0;
}
