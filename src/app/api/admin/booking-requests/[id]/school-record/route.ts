import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import {
  EmptySchoolNameError,
  previewSchoolRecordForName,
} from "@/lib/school-organisation-preview";
import { requireAdmin } from "@/lib/session-guards";

/**
 * GET /api/admin/booking-requests/[id]/school-record?name=… — #2936.
 *
 * WHICH SCHOOL WOULD THIS NAME RESOLVE TO? Read-only, and the reason the
 * correction form can make an officer confirm a consequence instead of
 * discovering it at approval: since #3367 a school request resolves to an
 * `Organisation` record inside the approval transaction, and that record owns
 * the school's Xero customer. So a corrected name either rejoins the school the
 * club already has — and its customer, and its invoice history — or mints a new
 * one, and only this answer tells them which.
 *
 * It mutates nothing and creates nothing. `resolveOrCreateSchoolOrganisation`
 * may only run inside the locked approval transaction; this asks the same
 * question through the same filter and only reads.
 *
 * `requireAdmin()` bare: a GET under `/api/admin/booking-requests` infers
 * `{ area: "bookings", level: "view" }`. Deliberately view-level — knowing which
 * school a name answers to is reading, and a view-only officer looking at a
 * request should be able to see the same thing the person correcting it sees.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const request = await prisma.bookingRequest.findUnique({
    where: { id },
    select: { id: true, type: true, schoolName: true },
  });
  if (!request) {
    return NextResponse.json(
      { error: "Booking request not found" },
      { status: 404 },
    );
  }
  if (request.type !== "SCHOOL") {
    return NextResponse.json(
      { error: "Only a school request resolves to a school record" },
      { status: 409 },
    );
  }

  // The candidate name, defaulting to the one already on the request so the
  // form can open with the current answer before anything is typed.
  const name = (req.nextUrl.searchParams.get("name") ?? request.schoolName ?? "").trim();

  try {
    const preview = await previewSchoolRecordForName(prisma, name);
    return NextResponse.json({ schoolRecord: preview });
  } catch (err) {
    if (err instanceof EmptySchoolNameError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
