import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { z } from "zod";

import { requireAdmin } from "@/lib/session-guards";
import { requireRecentAuth } from "@/lib/require-recent-auth";
import {
  readSchoolOrganisationContact,
  schoolContactDetailsSchema,
  SchoolContactEditError,
  updateSchoolOrganisationContact,
} from "@/lib/school-organisation-contact-edit";
import { kickQueuedXeroOutboxOperationsIfConnected } from "@/lib/xero-operation-outbox";
import logger from "@/lib/logger";

/**
 * GET/PATCH /api/admin/organisations/[id]/contact — #5245.
 *
 * A school's own email address and phone number, and the officer's correction
 * of them. Every rule is in `school-organisation-contact-edit.ts`; this parses,
 * delegates and maps refusals to status codes.
 *
 * `requireAdmin()` bare: the inferred requirement under
 * `/api/admin/organisations` is the bookings area — view to read, edit to
 * save — the gate the booking-request correction sits behind.
 */

const patchSchema = schoolContactDetailsSchema.extend({
  // The version the officer's screen loaded. A save over a record something
  // else has moved is refused rather than silently overwriting it.
  expectedUpdatedAt: z.string().datetime(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const school = await readSchoolOrganisationContact(id);
  if (!school) {
    return NextResponse.json({ error: "School not found." }, { status: 404 });
  }
  return NextResponse.json({ school });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;
  const { id } = await params;

  const read = await parseJsonRequestBody(req);
  if (!read.ok) return read.response;
  const parsed = patchSchema.safeParse(read.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  try {
    const result = await updateSchoolOrganisationContact({
      organisationId: id,
      email: parsed.data.email,
      phone: parsed.data.phone,
      expectedUpdatedAt: new Date(parsed.data.expectedUpdatedAt),
      actorId: session.user.id,
    });
    if (result.queueOperationId) {
      void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((error) => {
        logger.error(
          { err: error, organisationId: id },
          "Failed to kick the queued Xero update for a school's contact details",
        );
      });
    }
    return NextResponse.json({ result });
  } catch (error) {
    if (error instanceof SchoolContactEditError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
