import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { BookingRequestError, bookingRequestGuestSchema, serializeBookingRequestForAdmin } from "@/lib/booking-request";
import { BookingRequestCorrectionCommittedError } from "@/lib/booking-request-correction-hold";
import { correctBookingRequest } from "@/lib/booking-request-corrections";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/rate-limit";
import {
  EmptySchoolNameError,
  SchoolRecordAcknowledgementError,
} from "@/lib/school-organisation-preview";
import { schoolChildCountsSchema, schoolTeacherSchema } from "@/lib/school-booking-request";
import { requireAdmin } from "@/lib/session-guards";
import { nameField } from "@/lib/zod-helpers";

/**
 * POST /api/admin/booking-requests/[id]/correct — #2936.
 *
 * The ONE write behind the officer's "Correct this request" form. Every rule
 * lives in `booking-request-corrections.ts`; this handler parses, delegates and
 * maps refusals to status codes, so the service cannot be routed around by a
 * second caller with a looser idea of what a correction is.
 *
 * `requireAdmin()` bare: the inferred requirement for a POST under
 * `/api/admin/booking-requests` is `{ area: "bookings", level: "edit" }`, the
 * same gate price, hold, approve and decline sit behind.
 */

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

const noCrlf = (value: string) => !/[\r\n]/.test(value);

const schoolRecordAcknowledgementSchema = z.object({
  outcome: z.enum(["existing", "new"]),
  schoolRecordId: z.string().min(1).max(64).optional().nullable(),
});

const correctionSchema = z.object({
  // The row version the officer's screen was showing. The service refuses a
  // correction written over a request something else has moved.
  expectedVersion: z.number().int().min(0),
  reason: z
    .string()
    .min(1, "Record why you are correcting this request")
    .max(500)
    .refine(noCrlf, "The reason cannot contain line breaks"),
  checkIn: dateOnlyString.transform(parseDateOnly),
  checkOut: dateOnlyString.transform(parseDateOnly),
  contactFirstName: nameField(),
  contactLastName: nameField(),
  contactEmail: z.string().email("Invalid email address").max(200),
  contactPhone: z
    .string()
    .max(30)
    .refine(noCrlf, "Phone number cannot contain line breaks")
    .optional()
    .nullable(),
  // GENERAL requests send the corrected party in full.
  guests: z.array(bookingRequestGuestSchema).min(1).max(200).optional(),
  // SCHOOL requests send their own half instead: the same shapes the public
  // school form posts, plus the officer's answer to "which school is this?".
  school: z
    .object({
      schoolName: z
        .string()
        .min(1, "School name is required")
        .max(200)
        .refine(noCrlf, "School name cannot contain line breaks"),
      teachers: z.array(schoolTeacherSchema).min(1).max(50),
      childCounts: schoolChildCountsSchema,
      cateringPreference: z.enum(["CATERED", "NON_CATERED", "QUOTE_BOTH"]),
      schoolRecord: schoolRecordAcknowledgementSchema,
    })
    .optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = correctionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  const input = parsed.data;
  try {
    const result = await correctBookingRequest({
      requestId: id,
      adminMemberId: session.user.id,
      ipAddress: getClientIp(req),
      expectedVersion: input.expectedVersion,
      reason: input.reason,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      contactFirstName: input.contactFirstName,
      contactLastName: input.contactLastName,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone ?? null,
      guests: input.guests ?? null,
      school: input.school
        ? {
            schoolName: input.school.schoolName,
            teachers: input.school.teachers.map((teacher) => ({
              firstName: teacher.firstName,
              lastName: teacher.lastName,
              email: teacher.email ?? null,
            })),
            childCounts: input.school.childCounts,
            cateringPreference: input.school.cateringPreference,
            schoolRecord: input.school.schoolRecord,
          }
        : null,
    });

    const updated = await prisma.bookingRequest.findUnique({ where: { id } });
    if (!updated) {
      return NextResponse.json(
        { error: "Corrected booking request could not be reloaded" },
        { status: 500 },
      );
    }
    return NextResponse.json({
      request: serializeBookingRequestForAdmin(updated),
      changedFields: result.changedFields,
      holdOutcome: result.holdOutcome,
      supersededQuoteCount: result.supersededQuoteCount,
      schoolRecord: result.schoolRecord,
      availability: result.availability,
    });
  } catch (err) {
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    // The correction is ALREADY saved; only the bed release failed. Reported as
    // its own shape so the panel says what actually happened rather than
    // inviting a retry that would refuse on the bumped version anyway.
    if (err instanceof BookingRequestCorrectionCommittedError) {
      return NextResponse.json(
        {
          error: err.message,
          corrected: true,
          holdReleasePending: err.holdReleasePending,
        },
        { status: err.status },
      );
    }
    if (
      err instanceof BookingRequestError ||
      err instanceof SchoolRecordAcknowledgementError ||
      err instanceof EmptySchoolNameError
    ) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
