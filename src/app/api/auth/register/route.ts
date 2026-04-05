import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { sendWelcomeEmail } from "@/lib/email";
import { computeAgeTier } from "@/lib/age-tier";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { AgeTier } from "@prisma/client";
import logger from "@/lib/logger";

const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(12, "Password must be at least 12 characters"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  dateOfBirth: z.string().optional(),
  phone: z.string().optional(),
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

    const { email, password, firstName, lastName, dateOfBirth, phone } = parsed.data;

    const existing = await prisma.member.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existing) {
      return NextResponse.json(
        { error: "An account with this email already exists" },
        { status: 409 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 13);

    const ageTier = dateOfBirth ? computeAgeTier(new Date(dateOfBirth)) : AgeTier.ADULT;

    const member = await prisma.member.create({
      data: {
        email: email.toLowerCase(),
        passwordHash,
        firstName,
        lastName,
        ageTier,
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        phone: phone || null,
      },
    });

    // Fire-and-forget — don't fail registration if email errors
    sendWelcomeEmail(member.email, member.firstName).catch((err) => {
      logger.error({ err }, "Failed to send welcome email");
    });

    return NextResponse.json({ success: true, memberId: member.id }, { status: 201 });
  } catch (err) {
    logger.error({ err }, "Unexpected error in register");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
