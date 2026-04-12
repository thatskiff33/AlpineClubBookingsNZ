import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createMemberApplication,
  MembershipApplicationError,
} from "@/lib/nomination";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import logger from "@/lib/logger";

const maxStr = (len: number) => z.string().max(len).optional().nullable();
const cleanedString = (label: string, maxLength: number) =>
  z
    .string()
    .min(1, `${label} is required`)
    .max(maxLength, `${label} must be at most ${maxLength} characters`)
    .transform((value) => value.replace(/[\r\n]/g, " ").trim());

const applicationSchema = z.object({
  applicantFirstName: cleanedString("First name", 100),
  applicantLastName: cleanedString("Last name", 100),
  applicantEmail: z.string().email("Invalid email address").transform((value) => value.trim()),
  applicantDateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  phoneCountryCode: z.string().max(5).optional().nullable(),
  phoneAreaCode: z.string().max(5).optional().nullable(),
  phoneNumber: z.string().max(20).optional().nullable(),
  streetAddressLine1: maxStr(200),
  streetAddressLine2: maxStr(200),
  streetCity: maxStr(200),
  streetRegion: maxStr(200),
  streetPostalCode: maxStr(20),
  streetCountry: maxStr(100),
  postalAddressLine1: maxStr(200),
  postalAddressLine2: maxStr(200),
  postalCity: maxStr(200),
  postalRegion: maxStr(200),
  postalPostalCode: maxStr(20),
  postalCountry: maxStr(100),
  postalSameAsPhysical: z.boolean().optional(),
  familyMembers: z
    .array(
      z.object({
        firstName: cleanedString("Dependent first name", 100),
        lastName: cleanedString("Dependent last name", 100),
        dateOfBirth: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Dependent date of birth must be YYYY-MM-DD"),
      })
    )
    .max(10, "Please contact the club if you need to add more than 10 dependents")
    .default([]),
  nominator1Email: z.string().email("First nominator email is invalid").transform((value) => value.trim()),
  nominator2Email: z.string().email("Second nominator email is invalid").transform((value) => value.trim()),
});

export async function POST(req: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.membershipApplication, req);
  if (rateLimited) {
    return rateLimited;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = applicationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 422 }
    );
  }

  try {
    const result = await createMemberApplication({
      applicantFirstName: parsed.data.applicantFirstName,
      applicantLastName: parsed.data.applicantLastName,
      applicantEmail: parsed.data.applicantEmail,
      applicantDateOfBirth: parsed.data.applicantDateOfBirth,
      phoneCountryCode: parsed.data.phoneCountryCode,
      phoneAreaCode: parsed.data.phoneAreaCode,
      phoneNumber: parsed.data.phoneNumber,
      address: {
        streetAddressLine1: parsed.data.streetAddressLine1,
        streetAddressLine2: parsed.data.streetAddressLine2,
        streetCity: parsed.data.streetCity,
        streetRegion: parsed.data.streetRegion,
        streetPostalCode: parsed.data.streetPostalCode,
        streetCountry: parsed.data.streetCountry,
        postalAddressLine1: parsed.data.postalAddressLine1,
        postalAddressLine2: parsed.data.postalAddressLine2,
        postalCity: parsed.data.postalCity,
        postalRegion: parsed.data.postalRegion,
        postalPostalCode: parsed.data.postalPostalCode,
        postalCountry: parsed.data.postalCountry,
        postalSameAsPhysical: parsed.data.postalSameAsPhysical,
      },
      familyMembers: parsed.data.familyMembers,
      nominator1Email: parsed.data.nominator1Email,
      nominator2Email: parsed.data.nominator2Email,
    });

    return NextResponse.json(
      {
        success: true,
        applicationId: result.application.id,
        status: result.application.status,
        warnings: result.emailWarnings,
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof MembershipApplicationError) {
      return NextResponse.json(
        {
          error: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
        { status: err.status }
      );
    }

    logger.error({ err }, "Unexpected error creating membership application");
    return NextResponse.json(
      { error: "Unable to submit membership application right now" },
      { status: 500 }
    );
  }
}
