import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { confirmDevicePairing } from "@/lib/lodge-display-auth";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

// Admin bind step of lobby display pairing (fork issue hoppers99/AlpineClubBookingsNZ#27, ADR-001 §2.2):
// the admin reads the code off the TV and enters it against a device record;
// this persists pairingCode + expiry on that row, arming the device's claim
// poll. LTV-008 (hoppers99/AlpineClubBookingsNZ#33) builds the device-management UI that calls this.

const bodySchema = z.object({
  code: z.string().min(1).max(16),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const rateLimited = await applyRateLimit(rateLimiters.displayPairing, req);
  if (rateLimited) return rateLimited;

  let code: string;
  const jsonBody = await parseJsonRequestBody(req);
  if (!jsonBody.ok) return jsonBody.response;
  try {
    code = bodySchema.parse(jsonBody.body).code;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { id } = await params;
  const result = await confirmDevicePairing(id, code);

  if (!result.ok) {
    if (result.error === "not-found") {
      return NextResponse.json({ error: "Device not found" }, { status: 404 });
    }
    if (result.error === "revoked") {
      return NextResponse.json(
        { error: "Device has been revoked" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "Pairing code must be the 6 characters shown on the display" },
      { status: 400 }
    );
  }

  return NextResponse.json({
    ok: true,
    expiresAt: result.expiresAt.toISOString(),
  });
}
