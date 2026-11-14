import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  applyBedAllocationRemoval,
  BED_ALLOCATION_REMOVAL_CATEGORIES,
  BedAllocationRemovalError,
  MAX_BED_ALLOCATION_REMOVAL_WINDOW_NIGHTS,
  previewBedAllocationRemoval,
  type BedAllocationRemovalApplyRequest,
  type BedAllocationRemovalRequest,
} from "@/lib/bed-allocation-removal";
import {
  countNightsDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import {
  bedAllocationErrorResponse,
  requireBedAllocationRead,
  requireBedAllocationWrite,
} from "@/lib/admin-bed-allocation-routes";
import { dateOnlyStringSchema } from "@/lib/date-only-schema";

const anchorFields = {
  allocationId: z.string().min(1),
  bookingId: z.string().min(1),
  bookingGuestId: z.string().min(1),
  lodgeId: z.string().min(1),
  stayDate: dateOnlyStringSchema,
};

const windowScopeSchema = z
  .object({
    type: z.literal("WINDOW"),
    lodgeId: z.string().min(1),
    from: dateOnlyStringSchema,
    to: dateOnlyStringSchema,
  })
  .strict();

const scopeSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("ALLOCATION"), ...anchorFields }).strict(),
    z.object({ type: z.literal("BOOKING_GUEST"), ...anchorFields }).strict(),
    z.object({ type: z.literal("BOOKING"), ...anchorFields }).strict(),
    windowScopeSchema,
  ])
  .superRefine((scope, context) => {
    if (scope.type !== "WINDOW") return;
    if (!isDateOnlyString(scope.from) || !isDateOnlyString(scope.to)) {
      context.addIssue({ code: "custom", message: "Invalid removal window" });
      return;
    }
    const nights = countNightsDateOnly(
      parseDateOnly(scope.from),
      parseDateOnly(scope.to),
    );
    if (nights < 1 || nights > MAX_BED_ALLOCATION_REMOVAL_WINDOW_NIGHTS) {
      context.addIssue({
        code: "custom",
        message: `Removal window must cover 1 to ${MAX_BED_ALLOCATION_REMOVAL_WINDOW_NIGHTS} nights`,
      });
    }
  });

const categorySchema = z.enum(BED_ALLOCATION_REMOVAL_CATEGORIES);
const categoriesSchema = z
  .array(categorySchema)
  .min(1)
  .max(BED_ALLOCATION_REMOVAL_CATEGORIES.length)
  .superRefine((categories, context) => {
    if (new Set(categories).size !== categories.length) {
      context.addIssue({
        code: "custom",
        message: "Duplicate categories are not allowed",
      });
    }
  });

const previewSchema = z
  .object({ scope: scopeSchema, categories: categoriesSchema })
  .strict();
const applySchema = previewSchema
  .extend({ previewDigest: z.string().regex(/^v1:[0-9a-f]{64}$/) })
  .strict();

function invalidInput(error: z.ZodError) {
  return NextResponse.json(
    { error: "Invalid input", details: error.flatten() },
    { status: 400 },
  );
}

function removalErrorResponse(error: unknown) {
  if (error instanceof BedAllocationRemovalError) {
    return NextResponse.json(
      {
        error: error.message,
        ...(error.refreshedPreview
          ? { refreshedPreview: error.refreshedPreview }
          : {}),
      },
      { status: error.status },
    );
  }
  return bedAllocationErrorResponse(error);
}

/** Preview only: explicit bookings:view is sufficient and nothing is written. */
export async function POST(request: Request) {
  const guard = await requireBedAllocationRead();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;
    const parsed = previewSchema.safeParse(json.body);
    if (!parsed.success) return invalidInput(parsed.error);
    const preview = await previewBedAllocationRemoval(
      parsed.data as BedAllocationRemovalRequest,
    );
    return NextResponse.json(preview);
  } catch (error) {
    return removalErrorResponse(error);
  }
}

/** Apply the exact reviewed preview; explicit bookings:edit is required. */
export async function PUT(request: Request) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;
    const parsed = applySchema.safeParse(json.body);
    if (!parsed.success) return invalidInput(parsed.error);
    const result = await applyBedAllocationRemoval({
      request: parsed.data as BedAllocationRemovalApplyRequest,
      actorMemberId: guard.session.user.id,
    });
    return NextResponse.json(result);
  } catch (error) {
    return removalErrorResponse(error);
  }
}
