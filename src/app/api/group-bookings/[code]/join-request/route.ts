import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { parseJsonRequestBody } from "@/lib/api-json";
import { ageTierEnum } from "@/lib/age-tier-schema";
import { nameField } from "@/lib/zod-helpers";
import {
  createNonMemberJoinRequest,
  GroupBookingError,
} from "@/lib/group-booking";
import logger from "@/lib/logger";

const NEUTRAL_JOIN_REQUEST_RESPONSE = { success: true } as const;
const NEUTRAL_JOIN_REQUEST_ERROR_CODES = new Set([
  "GROUP_NOT_FOUND",
  "GROUP_NOT_JOINABLE",
  "GROUP_NOT_INDIVIDUAL_SIGNUP",
  "GROUP_BOOKING_INACTIVE",
  "USE_MEMBER_LOGIN",
]);

const noCrlf = (value: string) => !/[\r\n]/.test(value);

const joinRequestSchema = z
  .object({
    contactFirstName: nameField(),
    contactLastName: nameField(),
    contactEmail: z.string().email("Invalid email address").max(200),
    contactPhone: z
      .string()
      .max(30)
      .refine(noCrlf, "Phone number cannot contain line breaks")
      .optional()
      .nullable(),
    guests: z
      .array(
        z.object({
          firstName: nameField(),
          lastName: nameField(),
          ageTier: ageTierEnum,
        })
      )
      .min(1)
      .max(50),
  })
  .strict();

/**
 * Public: a non-member asks to join a group by its code. Stages the request and
 * emails a verification link; no booking is created until the email is verified.
 * Mirrors POST /api/booking-requests.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const rateLimited = applyRateLimit(rateLimiters.groupBookingJoinRequest, request);
  if (rateLimited) return rateLimited;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const parsed = joinRequestSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { code } = await params;
  try {
    await createNonMemberJoinRequest({
      code,
      contactFirstName: parsed.data.contactFirstName,
      contactLastName: parsed.data.contactLastName,
      contactEmail: parsed.data.contactEmail,
      contactPhone: parsed.data.contactPhone,
      guests: parsed.data.guests,
    });
    // Always return a neutral success so the endpoint cannot be used to probe
    // which emails or codes exist.
    return NextResponse.json(NEUTRAL_JOIN_REQUEST_RESPONSE, { status: 201 });
  } catch (err) {
    if (err instanceof GroupBookingError) {
      if (err.code && NEUTRAL_JOIN_REQUEST_ERROR_CODES.has(err.code)) {
        return NextResponse.json(NEUTRAL_JOIN_REQUEST_RESPONSE, {
          status: 201,
        });
      }
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    logger.error({ err }, "Unexpected error creating group join request");
    return NextResponse.json(
      { error: "Unable to submit your request right now" },
      { status: 500 }
    );
  }
}
