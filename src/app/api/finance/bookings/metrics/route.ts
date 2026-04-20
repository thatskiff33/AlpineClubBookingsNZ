import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireFinanceViewerApiAccess } from "@/lib/finance-api-auth";
import { getFinanceBookingMetrics } from "@/lib/finance-booking-metrics";

const isoDateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const financeBookingMetricsQuerySchema = z
  .object({
    realizedFrom: isoDateParam.optional(),
    realizedTo: isoDateParam.optional(),
    realizedCutoff: isoDateParam.optional(),
    forwardFrom: isoDateParam.optional(),
    forwardTo: isoDateParam.optional(),
    forwardAsOf: isoDateParam.optional(),
  })
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
  });

export async function GET(request: NextRequest) {
  const authResult = await requireFinanceViewerApiAccess();

  if (!authResult.ok) {
    return authResult.response;
  }

  const { searchParams } = new URL(request.url);
  const parsed = financeBookingMetricsQuerySchema.safeParse({
    realizedFrom: searchParams.get("realizedFrom") ?? undefined,
    realizedTo: searchParams.get("realizedTo") ?? undefined,
    realizedCutoff: searchParams.get("realizedCutoff") ?? undefined,
    forwardFrom: searchParams.get("forwardFrom") ?? undefined,
    forwardTo: searchParams.get("forwardTo") ?? undefined,
    forwardAsOf: searchParams.get("forwardAsOf") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          "Invalid finance booking metrics query. Use paired realizedFrom/realizedTo and/or forwardFrom/forwardTo dates in YYYY-MM-DD format.",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  try {
    const metrics = await getFinanceBookingMetrics({
      ...(parsed.data.realizedFrom && parsed.data.realizedTo
        ? {
            realized: {
              from: parsed.data.realizedFrom,
              to: parsed.data.realizedTo,
              cutoffDate: parsed.data.realizedCutoff,
            },
          }
        : {}),
      ...(parsed.data.forwardFrom && parsed.data.forwardTo
        ? {
            forward: {
              from: parsed.data.forwardFrom,
              to: parsed.data.forwardTo,
              asOfDate: parsed.data.forwardAsOf,
            },
          }
        : {}),
    });

    return NextResponse.json(metrics);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load finance booking metrics";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
