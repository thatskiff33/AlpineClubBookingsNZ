import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createMemberApplication,
  MembershipApplicationError,
} from "@/lib/nomination";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { isCalendarDate } from "@/lib/club-time";

const maxStr = (len: number) => z.string().max(len).optional().nullable();

/**
 * A DATE OF BIRTH THAT NAMES A REAL DAY, not merely one shaped like a date
 * (#3082 fix round).
 *
 * This endpoint is UNAUTHENTICATED — rate-limited and nothing else — and both
 * fields it validates end up feeding an age tier, which selects a price band.
 * The bare `/^\d{4}-\d{2}-\d{2}$/` this replaces is a SHAPE check: it accepts
 * `1990-13-01`, `1990-06-32`, `1990-00-15` and `0000-05-05`, and it accepts
 * `1990-02-31`, which `new Date` then silently rolls to 3 March. The dependents
 * land in a `Json` column, so PostgreSQL never sees them either.
 *
 * `nominations/[token]/page.tsx` names this gap in its own docblock and says
 * tightening the write paths "is deliberately NOT done here" because reading a
 * value must not be able to take a page down whatever was written. That is still
 * the rule for the READERS — `isoDateSchema` in `nomination.ts` stays loose, and
 * so does that page — and this is the other half it was waiting for: refuse the
 * value where it ARRIVES, once, so no reader has to cope with it and no
 * membership approval can be wedged by it.
 *
 * `isCalendarDate` is the kernel's own predicate, so "a real day" means exactly
 * what it means everywhere else in this codebase: four-digit year from 0001,
 * month 1-12, and a day that exists in that month.
 */
const calendarDayOfBirth = (label: string) =>
  z.string().superRefine((value, context) => {
    // ONE ISSUE, NOT TWO. A `.regex(...).refine(...)` pair reports both messages
    // for `"01/02/1990"`, which is noise in a field-level form error: the shape
    // is the only thing wrong with it and the caller is told twice.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      context.addIssue({ code: "custom", message: `${label} must be YYYY-MM-DD` });
      return;
    }
    if (!isCalendarDate(value)) {
      context.addIssue({ code: "custom", message: `${label} must be a real date` });
    }
  });

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
  applicantDateOfBirth: calendarDayOfBirth("Date of birth"),
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
        dateOfBirth: calendarDayOfBirth("Dependent date of birth"),
      })
    )
    .max(10, "Please contact the club if you need to add more than 10 dependents")
    .default([]),
  nominator1Email: z.string().email("First nominator email is invalid").transform((value) => value.trim()),
  nominator2Email: z.string().email("Second nominator email is invalid").transform((value) => value.trim()),
});

export async function POST(req: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.membershipApplication, req);
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
