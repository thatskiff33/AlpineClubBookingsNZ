import { NextRequest, NextResponse } from "next/server";
import { SchoolCateringPreference } from "@prisma/client";
import { z } from "zod";
import {
  assertRequestedLodgeActive,
  BookingRequestError,
} from "@/lib/booking-request";
import {
  createSchoolBookingRequest,
  generateSchoolGuests,
  schoolChildCountsSchema,
  schoolTeacherSchema,
} from "@/lib/school-booking-request";
import { getDefaultLodgeCapacity, getLodgeCapacity } from "@/lib/lodge-capacity";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { nameField } from "@/lib/zod-helpers";
import logger from "@/lib/logger";

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

const noCrlf = (value: string) => !/[\r\n]/.test(value);

const schoolBookingRequestSchema = z.object({
  schoolName: z
    .string()
    .min(1, "School name is required")
    .max(200)
    .refine(noCrlf, "School name cannot contain line breaks"),
  contactFirstName: nameField(),
  contactLastName: nameField(),
  contactEmail: z.string().email("Invalid email address").max(200),
  contactPhone: z
    .string()
    .max(30)
    .refine(noCrlf, "Phone number cannot contain line breaks")
    .optional()
    .nullable(),
  checkIn: dateOnlyString.transform(parseDateOnly),
  checkOut: dateOnlyString.transform(parseDateOnly),
  // Lodge the stay is requested at; omitted means the club's default lodge.
  lodgeId: z.string().min(1).optional(),
  cateringPreference: z
    .enum(["CATERED", "NON_CATERED", "QUOTE_BOTH"])
    .default("QUOTE_BOTH"),
  teachers: z.array(schoolTeacherSchema).min(1, "At least one teacher is required").max(50),
  childCounts: schoolChildCountsSchema,
  // Whole-lodge exclusivity request (issue #121). School front-door only — the
  // general booking-request path deliberately does not accept this.
  exclusivityRequested: z.boolean().optional().default(false),
  message: z
    .string()
    .max(1000)
    .refine(noCrlf, "Message cannot contain line breaks")
    .optional()
    .nullable(),
});

export async function POST(request: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.bookingRequest, request);
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = schoolBookingRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { checkIn, checkOut, teachers, childCounts } = parsed.data;

  if (checkOut <= checkIn) {
    return NextResponse.json({ error: "Check-out must be after check-in" }, { status: 400 });
  }

  // CT-4 (#2870): the club's day, from the persisted ClubTimeSettings zone and
  // not the container's TZ (INV-CONFIG-002, INV-DATE-019), encoded at UTC
  // midnight so it shares a frame with the submitted date-only values.
  const today = await clubTodayDateOnlyInstant();
  if (checkIn < today) {
    return NextResponse.json({ error: "Cannot request a booking in the past" }, { status: 400 });
  }

  const guests = generateSchoolGuests({ teachers, childCounts });
  if (guests.length === 0) {
    return NextResponse.json(
      { error: "Add at least one teacher and one child" },
      { status: 400 }
    );
  }

  try {
    // A provided lodgeId must name an ACTIVE lodge (400 otherwise); omitted
    // means the club's default lodge, stored as null.
    const lodgeId = await assertRequestedLodgeActive(parsed.data.lodgeId);

    const lodgeCapacity = lodgeId
      ? await getLodgeCapacity(lodgeId)
      : await getDefaultLodgeCapacity();
    if (guests.length > lodgeCapacity) {
      return NextResponse.json(
        { error: `A school booking cannot exceed the lodge capacity of ${lodgeCapacity} guests` },
        { status: 400 }
      );
    }

    await createSchoolBookingRequest({
      schoolName: parsed.data.schoolName,
      contactFirstName: parsed.data.contactFirstName,
      contactLastName: parsed.data.contactLastName,
      contactEmail: parsed.data.contactEmail,
      contactPhone: parsed.data.contactPhone,
      checkIn,
      checkOut,
      cateringPreference: parsed.data.cateringPreference as SchoolCateringPreference,
      teachers,
      childCounts,
      exclusivityRequested: parsed.data.exclusivityRequested,
      message: parsed.data.message,
      lodgeId,
    });

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (err) {
    if (err instanceof BookingRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    logger.error({ err }, "Unexpected error creating school booking request");
    return NextResponse.json(
      { error: "Unable to submit school booking request right now" },
      { status: 500 }
    );
  }
}
