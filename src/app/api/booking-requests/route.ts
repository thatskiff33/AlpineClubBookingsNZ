import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  assertRequestedLodgeActive,
  assertRequestedOtherLodgeExists,
  bookingRequestGuestSchema,
  BookingRequestError,
  createBookingRequest,
} from "@/lib/booking-request";
import { getDefaultLodgeCapacity, getLodgeCapacity } from "@/lib/lodge-capacity";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { getTodayDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { nameField } from "@/lib/zod-helpers";
import logger from "@/lib/logger";

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

const noCrlf = (value: string) => !/[\r\n]/.test(value);

const bookingRequestSchema = z.object({
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
  // Other/partner lodge the requester says they belong to (#2749); omitted or
  // blank means "No". Validated against the OtherLodge registry below.
  otherLodgeId: z.string().min(1).optional(),
  guests: z.array(bookingRequestGuestSchema).min(1).max(200),
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

  const parsed = bookingRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { checkIn, checkOut, guests } = parsed.data;

  if (checkOut <= checkIn) {
    return NextResponse.json({ error: "Check-out must be after check-in" }, { status: 400 });
  }

  const today = getTodayDateOnly();
  if (checkIn < today) {
    return NextResponse.json({ error: "Cannot request a booking in the past" }, { status: 400 });
  }

  try {
    // A provided lodgeId must name an ACTIVE lodge (400 otherwise); omitted
    // means the club's default lodge, stored as null.
    const lodgeId = await assertRequestedLodgeActive(parsed.data.lodgeId);

    // A provided otherLodgeId must name an existing OtherLodge (400 otherwise);
    // omitted/blank means "No" (stored as null).
    const otherLodgeId = await assertRequestedOtherLodgeExists(
      parsed.data.otherLodgeId,
    );

    const lodgeCapacity = lodgeId
      ? await getLodgeCapacity(lodgeId)
      : await getDefaultLodgeCapacity();
    if (guests.length > lodgeCapacity) {
      return NextResponse.json(
        { error: `A booking request cannot exceed ${lodgeCapacity} guests` },
        { status: 400 }
      );
    }

    await createBookingRequest({
      contactFirstName: parsed.data.contactFirstName,
      contactLastName: parsed.data.contactLastName,
      contactEmail: parsed.data.contactEmail,
      contactPhone: parsed.data.contactPhone,
      checkIn,
      checkOut,
      guests,
      message: parsed.data.message,
      lodgeId,
      otherLodgeId,
    });

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (err) {
    if (err instanceof BookingRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    logger.error({ err }, "Unexpected error creating booking request");
    return NextResponse.json(
      { error: "Unable to submit booking request right now" },
      { status: 500 }
    );
  }
}
