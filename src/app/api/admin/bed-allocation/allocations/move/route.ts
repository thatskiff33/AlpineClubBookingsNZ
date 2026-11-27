import { NextResponse } from "next/server";
import {
  BedAllocationMoveError,
  previewBedAllocationMove,
  type BedAllocationMoveRequest,
} from "@/lib/bed-allocation-move";
import {
  bedAllocationErrorResponse,
  requireBedAllocationRead,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { bedAllocationMovePreviewBodySchema } from "@/lib/admin-bookings-schemas/beds";
import { ADMIN_BED_ALLOCATION_MOVE_PREVIEW_CONNECTION_SHAPE } from "@/lib/connection-shapes/bookings-beds";
import { connectionJson } from "@/lib/mcp-connection-request";

function moveErrorResponse(error: unknown) {
  if (error instanceof BedAllocationMoveError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
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
 * Read-only authoritative preview; explicit bookings:view is sufficient.
 * Also the AI app action `preview_bed_allocation_move` (ALP-719).
 */
export async function POST(request: Request) {
  const guard = await requireBedAllocationRead();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;
    const parsed = bedAllocationMovePreviewBodySchema.safeParse(json.body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    return connectionJson(
      request,
      await previewBedAllocationMove(parsed.data as BedAllocationMoveRequest),
      ADMIN_BED_ALLOCATION_MOVE_PREVIEW_CONNECTION_SHAPE,
    );
  } catch (error) {
    return moveErrorResponse(error);
  }
}
