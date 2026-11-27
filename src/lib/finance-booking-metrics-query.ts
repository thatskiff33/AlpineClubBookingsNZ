/**
 * The finance workspace's booking metrics windows (`GET
 * /api/finance/bookings/metrics`): the route and its AI app action read them
 * (ALP-721, `INV-SSOT`). Every date is a real calendar day, `YYYY-MM-DD`.
 */
import { z } from "zod";

import { dateOnlyStringSchema } from "@/lib/date-only-schema";
import { getFinanceBookingMetricsWindowDayCount } from "@/lib/finance-booking-metric-calculations";

/** The longest window either section may cover. */
export const MAX_FINANCE_BOOKING_METRICS_WINDOW_DAYS = 366;

function validateWindowSpan(
  input: {
    from?: string;
    to?: string;
  },
  path: "realized" | "forward",
  context: z.RefinementCtx
) {
  if (!input.from || !input.to) {
    return;
  }

  // A non-day is already refused on its own field by `dateOnlyStringSchema`;
  // measuring the span too would add a second, vaguer error for one mistake.
  if (
    !dateOnlyStringSchema.safeParse(input.from).success ||
    !dateOnlyStringSchema.safeParse(input.to).success
  ) {
    return;
  }

  try {
    const dayCount = getFinanceBookingMetricsWindowDayCount(
      input.from,
      input.to
    );
    if (dayCount > MAX_FINANCE_BOOKING_METRICS_WINDOW_DAYS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message: `${path} window cannot exceed ${MAX_FINANCE_BOOKING_METRICS_WINDOW_DAYS} days`,
      });
    }
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [path],
      message: error instanceof Error ? error.message : "Invalid date window",
    });
  }
}

// Every date is a real calendar day, not just its shape: a bare regex let
// `realizedCutoff=2026-02-30` through to the metrics loader, which threw on it
// and answered 500 (#5075).
export const financeBookingMetricsQueryFields = {
  realizedFrom: dateOnlyStringSchema.optional(),
  realizedTo: dateOnlyStringSchema.optional(),
  realizedCutoff: dateOnlyStringSchema.optional(),
  forwardFrom: dateOnlyStringSchema.optional(),
  forwardTo: dateOnlyStringSchema.optional(),
  forwardAsOf: dateOnlyStringSchema.optional(),
};

export const financeBookingMetricsQuerySchema = z
  .object(financeBookingMetricsQueryFields)
  .superRefine((value, context) => {
    if (Boolean(value.realizedFrom) !== Boolean(value.realizedTo)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["realized"],
        message: "realizedFrom and realizedTo must be provided together",
      });
    }

    if (Boolean(value.forwardFrom) !== Boolean(value.forwardTo)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["forward"],
        message: "forwardFrom and forwardTo must be provided together",
      });
    }

    if (!value.realizedFrom && !value.forwardFrom) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["query"],
        message:
          "Provide realizedFrom/realizedTo, forwardFrom/forwardTo, or both",
      });
    }

    validateWindowSpan(
      { from: value.realizedFrom, to: value.realizedTo },
      "realized",
      context
    );
    validateWindowSpan(
      { from: value.forwardFrom, to: value.forwardTo },
      "forward",
      context
    );
  });
