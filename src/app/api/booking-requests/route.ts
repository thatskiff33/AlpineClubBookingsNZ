import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  bookingRequestGuestSchema,
  BookingRequestError,
  createBookingRequest,
} from "@/lib/booking-request";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
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
  guests: z.array(bookingRequestGuestSchema).min(1).max(200),
  message: z
    .string()
    .max(1000)
    .refine(noCrlf, "Message cannot contain line breaks")
    .optional()
    .nullable(),
});

export async function POST(request: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.bookingRequest, request);
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

  const lodgeCapacity = await getLodgeCapacity();
  if (guests.length > lodgeCapacity) {
    return NextResponse.json(
      { error: `A booking request cannot exceed ${lodgeCapacity} guests` },
      { status: 400 }
    );
  }

  try {
    await createBookingRequest({
      contactFirstName: parsed.data.contactFirstName,
      contactLastName: parsed.data.contactLastName,
      contactEmail: parsed.data.contactEmail,
      contactPhone: parsed.data.contactPhone,
      checkIn,
      checkOut,
      guests,
      message: parsed.data.message,
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
