"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  useForm,
  type FieldValues,
  type UseFormProps,
  type UseFormReturn,
} from "react-hook-form";
import type { z } from "zod";

/**
 * A react-hook-form form validated by one zod schema (#4467). The schema is
 * the one the API route parses with, or built from the same field rules
 * (`src/lib/forms/`), so the browser and the route cannot disagree about what
 * is valid. `handleSubmit` hands the submit handler the schema's OUTPUT: the
 * payload to send, already trimmed and normalised.
 *
 * Two settings are fixed rather than left to each form:
 *
 * - `shouldFocusError: false`. `FormErrorSummary` takes focus on a failed
 *   submit; react-hook-form's own focus-the-first-error would take it back on
 *   a timer a tick later.
 * - Validation runs on submit, then again on change for a field that has
 *   already failed (react-hook-form's defaults, restated): an error appears
 *   when the person submits, and clears as they fix it.
 */
export function useZodForm<
  TInput extends FieldValues,
  TOutput extends FieldValues,
>(
  schema: z.ZodType<TOutput, TInput>,
  options: Omit<
    UseFormProps<TInput, unknown, TOutput>,
    "resolver" | "shouldFocusError" | "mode" | "reValidateMode"
  > = {},
): UseFormReturn<TInput, unknown, TOutput> {
  return useForm<TInput, unknown, TOutput>({
    ...options,
    mode: "onSubmit",
    reValidateMode: "onChange",
    shouldFocusError: false,
    resolver: zodResolver(schema),
  });
}
