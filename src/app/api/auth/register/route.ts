import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { sendWelcomeEmail, sendVerificationEmail } from "@/lib/email";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { getSeasonYear } from "@/lib/utils";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { createEmailVerificationToken } from "@/lib/verification-tokens";
import { AgeTier } from "@prisma/client";
import { isXeroConnected, findOrCreateXeroContact } from "@/lib/xero";
import logger from "@/lib/logger";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
import { copyStreetAddressToPostal } from "@/lib/member-address";

const maxStr = (len: number) => z.string().max(len).optional().nullable();

const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(12, "Password must be at least 12 characters").max(128, "Password must be at most 128 characters"),
  firstName: z.string().min(1, "First name is required").transform((s) => s.replace(/[\r\n]/g, " ").trim()),
  lastName: z.string().min(1, "Last name is required").transform((s) => s.replace(/[\r\n]/g, " ").trim()),
  dateOfBirth: z.string().optional(),
  phoneCountryCode: z.string().max(5).optional(),
  phoneAreaCode: z.string().max(5).optional(),
  phoneNumber: z.string().max(15).optional(),
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
});

export async function POST(req: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.register, req);
  if (rateLimited) return rateLimited;

  try {
    const body = await req.json();
    const parsed = registerSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const {
      email,
      password,
      firstName,
      lastName,
      dateOfBirth,
      phoneCountryCode,
      phoneAreaCode,
      phoneNumber,
      streetAddressLine1,
      streetAddressLine2,
      streetCity,
      streetRegion,
      streetPostalCode,
      streetCountry,
      postalAddressLine1,
      postalAddressLine2,
      postalCity,
      postalRegion,
      postalPostalCode,
      postalCountry,
      postalSameAsPhysical,
    } = parsed.data;

    const existing = await prisma.member.findFirst({
      where: { email: email.toLowerCase(), canLogin: true },
    });

    if (existing) {
      return NextResponse.json(
        { error: "An account with this email already exists" },
        { status: 409 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 13);

    const ageTier = dateOfBirth
      ? await computeAgeTier(new Date(dateOfBirth), getSeasonStartDate(getSeasonYear()))
      : AgeTier.ADULT;

    const postalAddress = postalSameAsPhysical
      ? copyStreetAddressToPostal({
          streetAddressLine1,
          streetAddressLine2,
          streetCity,
          streetRegion,
          streetPostalCode,
          streetCountry,
        })
      : {
          postalAddressLine1,
          postalAddressLine2,
          postalCity,
          postalRegion,
          postalPostalCode,
          postalCountry,
        };

    const member = await prisma.member.create({
      data: {
        email: email.toLowerCase(),
        passwordHash,
        firstName,
        lastName,
        ageTier,
        canLogin: true,
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        phoneCountryCode: phoneCountryCode?.trim() || null,
        phoneAreaCode: phoneAreaCode?.trim() || null,
        phoneNumber: phoneNumber?.trim() || null,
        streetAddressLine1: streetAddressLine1?.trim() || null,
        streetAddressLine2: streetAddressLine2?.trim() || null,
        streetCity: streetCity?.trim() || null,
        streetRegion: streetRegion?.trim() || null,
        streetPostalCode: streetPostalCode?.trim() || null,
        streetCountry: streetCountry?.trim() || null,
        postalAddressLine1: postalAddress.postalAddressLine1?.trim() || null,
        postalAddressLine2: postalAddress.postalAddressLine2?.trim() || null,
        postalCity: postalAddress.postalCity?.trim() || null,
        postalRegion: postalAddress.postalRegion?.trim() || null,
        postalPostalCode: postalAddress.postalPostalCode?.trim() || null,
        postalCountry: postalAddress.postalCountry?.trim() || null,
      },
    });

    // Generate verification token and send verification email
    createEmailVerificationToken(member.id)
      .then((token) => sendVerificationEmail(member.email, member.firstName, token))
      .catch((err) => {
        logger.error({ err }, "Failed to send verification email");
      });

    // Also send welcome email (fire-and-forget)
    sendWelcomeEmail(member.email, member.firstName).catch((err) => {
      logger.error({ err }, "Failed to send welcome email");
    });

    // Fire-and-forget: create Xero contact for new member (if Xero is connected)
    isXeroConnected().then(connected => {
      if (connected) {
        findOrCreateXeroContact(member.id).catch(err => {
          logger.warn({ err, memberId: member.id }, "Failed to auto-create Xero contact on registration");
        });
      }
    }).catch(() => {});

    return NextResponse.json({ success: true, memberId: member.id }, { status: 201 });
  } catch (err) {
    if (isPrismaUniqueConstraintError(err)) {
      return NextResponse.json(
        { error: "An account with this email already exists" },
        { status: 409 }
      );
    }

    logger.error({ err }, "Unexpected error in register");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
