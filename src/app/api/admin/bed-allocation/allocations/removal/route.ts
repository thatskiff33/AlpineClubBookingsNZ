import { NextResponse } from "next/server";
import type { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  applyBedAllocationRemoval,
  BedAllocationRemovalError,
  previewBedAllocationRemoval,
  type BedAllocationRemovalApplyRequest,
  type BedAllocationRemovalRequest,
} from "@/lib/bed-allocation-removal";
import {
  bedAllocationErrorResponse,
  requireBedAllocationRead,
  requireBedAllocationWrite,
} from "@/lib/admin-bed-allocation-routes";
import {
  bedAllocationRemovalApplyBodySchema,
  bedAllocationRemovalPreviewBodySchema,
} from "@/lib/admin-bookings-schemas/beds";
import {
  ADMIN_BED_ALLOCATION_REMOVAL_CONNECTION_SHAPE,
  ADMIN_BED_ALLOCATION_REMOVAL_PREVIEW_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/bookings-beds";
import { connectionJson } from "@/lib/mcp-connection-request";

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

/**
 * Preview only: explicit bookings:view is sufficient and nothing is written.
 * Also the AI app action `preview_bed_allocation_removal` (ALP-719).
 */
export async function POST(request: Request) {
  const guard = await requireBedAllocationRead();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;
    const parsed = bedAllocationRemovalPreviewBodySchema.safeParse(json.body);
    if (!parsed.success) return invalidInput(parsed.error);
    const preview = await previewBedAllocationRemoval(
      parsed.data as BedAllocationRemovalRequest,
    );
    return connectionJson(request, preview, ADMIN_BED_ALLOCATION_REMOVAL_PREVIEW_CONNECTION_SHAPE);
  } catch (error) {
    return removalErrorResponse(error);
  }
}

/**
 * Apply the exact reviewed preview; explicit bookings:edit is required.
 * Also the AI app action `remove_bed_allocations` (ALP-719).
 */
export async function PUT(request: Request) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;
    const parsed = bedAllocationRemovalApplyBodySchema.safeParse(json.body);
    if (!parsed.success) return invalidInput(parsed.error);
    const result = await applyBedAllocationRemoval({
      request: parsed.data as BedAllocationRemovalApplyRequest,
      actorMemberId: guard.session.user.id,
    });
    return connectionJson(request, result, ADMIN_BED_ALLOCATION_REMOVAL_CONNECTION_SHAPE);
  } catch (error) {
    return removalErrorResponse(error);
  }
}
