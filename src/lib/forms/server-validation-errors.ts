import type {
  FieldPath,
  FieldValues,
  UseFormGetValues,
  UseFormSetError,
} from "react-hook-form";

import {
  joinFieldMessages,
  labelFieldMessages,
  readValidationDetails,
} from "@/lib/format-validation-errors";

/**
 * The statuses a route answers a schema refusal with: 400 on most routes, 422
 * on the member routes. Any other status is not a field refusal, whatever its
 * body carries.
 */
const VALIDATION_REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 422]);

/**
 * Put an API route's validation refusal back on the form that sent it (#4467).
 *
 * The routes answer a body their zod schema refuses with
 * `{ error, details: parsed.error.flatten() }` and a 400 (the member routes:
 * `details: parsed.error.flatten().fieldErrors` and a 422). This maps a
 * response only when it is that: a 400 or 422 whose `details`
 * `readValidationDetails` (the one reader of the shape) recognises as zod's.
 *
 * - a message for a field the form has goes on that field (`type: "server"`),
 *   so it shows inline and in `FormErrorSummary`;
 * - a form-level message, or one for a key the form does not render, goes on
 *   `root.server`, labelled the way `formatValidationErrorResponse` labels
 *   it, and the summary shows it without a link.
 *
 * Call it inside the `handleSubmit` callback, before it returns: the summary
 * takes focus when the submit completes, and errors set later would not move
 * it. It returns whether anything was set; when nothing was (a 403, a 500, a
 * 400 with no zod `details`), the caller shows the route's `error` as usual.
 */
export function applyServerValidationErrors<TFieldValues extends FieldValues>(
  form: {
    setError: UseFormSetError<TFieldValues>;
    getValues: UseFormGetValues<TFieldValues>;
  },
  status: number,
  body: unknown,
): boolean {
  if (!VALIDATION_REFUSAL_STATUSES.has(status)) return false;
  const details = readValidationDetails(body);
  if (!details) return false;

  const fields = new Set(Object.keys(form.getValues() ?? {}));
  const formLevel = [...details.formErrors];

  for (const [field, messages] of details.fieldErrors) {
    if (fields.has(field)) {
      form.setError(field as FieldPath<TFieldValues>, {
        type: "server",
        message: joinFieldMessages(messages),
      });
    } else {
      formLevel.push(labelFieldMessages(field, messages));
    }
  }

  if (formLevel.length > 0) {
    form.setError("root.server", {
      type: "server",
      message: joinFieldMessages(formLevel),
    });
  }

  return details.fieldErrors.length > 0 || formLevel.length > 0;
}
