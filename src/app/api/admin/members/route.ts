import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hash } from "bcryptjs";
import { randomBytes } from "crypto";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeAgeTier } from "@/lib/age-tier";
import { isXeroConnected, findOrCreateXeroContact } from "@/lib/xero";
import { sendPasswordResetEmail } from "@/lib/email";
import { getSeasonYear } from "@/lib/utils";
import logger from "@/lib/logger";

const createMemberSchema = z.object({
  email: z.string().email("Invalid email address"),
  firstName: z.string().min(1, "First name is required").max(100),
  lastName: z.string().min(1, "Last name is required").max(100),
  phone: z.string().max(20).optional().nullable(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format")
    .optional()
    .nullable(),
  role: z.enum(["MEMBER", "ADMIN"]).default("MEMBER"),
  ageTier: z.enum(["ADULT", "YOUTH", "CHILD"]).optional(),
  active: z.boolean().default(true),
  sendInvite: z.boolean().default(false),
});

/**
 * GET /api/admin/members
 * List members with optional search query.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const q = req.nextUrl.searchParams.get("q") || undefined;

  const currentSeasonYear = getSeasonYear(new Date());

  const members = await prisma.member.findMany({
    where: q
      ? {
          OR: [
            { firstName: { contains: q, mode: "insensitive" } },
            { lastName: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
          ],
        }
      : undefined,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      dateOfBirth: true,
      role: true,
      ageTier: true,
      active: true,
      xeroContactId: true,
      createdAt: true,
      subscriptions: {
        where: { seasonYear: currentSeasonYear },
        select: { status: true, seasonYear: true, xeroInvoiceId: true },
        take: 1,
      },
    },
  });

  const membersWithSub = members.map((m) => ({
    ...m,
    subscriptionStatus: m.subscriptions[0]?.status ?? null,
    subscriptionXeroInvoiceId: m.subscriptions[0]?.xeroInvoiceId ?? null,
    subscriptions: undefined,
  }));

  return NextResponse.json({ members: membersWithSub });
}

/**
 * POST /api/admin/members
 * Create a new member.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createMemberSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const data = parsed.data;
  const email = data.email.toLowerCase().trim();

  // Check for existing member
  const existing = await prisma.member.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json(
      { error: "A member with this email already exists" },
      { status: 409 }
    );
  }

  // Determine age tier from DOB if provided, otherwise use explicit value or default
  let ageTier = data.ageTier || "ADULT";
  let dateOfBirth: Date | null = null;
  if (data.dateOfBirth) {
    dateOfBirth = new Date(data.dateOfBirth);
    if (isNaN(dateOfBirth.getTime())) {
      return NextResponse.json({ error: "Invalid date of birth" }, { status: 422 });
    }
    ageTier = computeAgeTier(dateOfBirth);
  }

  // Random unguessable password
  const placeholderHash = await hash(randomBytes(32).toString("hex"), 13);

  try {
    const member = await prisma.member.create({
      data: {
        email,
        firstName: data.firstName.trim(),
        lastName: data.lastName.trim(),
        phone: data.phone?.trim() || null,
        dateOfBirth,
        role: data.role,
        ageTier: ageTier as "ADULT" | "YOUTH" | "CHILD",
        active: data.active,
        passwordHash: placeholderHash,
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        dateOfBirth: true,
        role: true,
        ageTier: true,
        active: true,
        xeroContactId: true,
        createdAt: true,
      },
    });

    // Sync to Xero if connected
    try {
      if (await isXeroConnected()) {
        await findOrCreateXeroContact(member.id);
      }
    } catch (xeroErr) {
      logger.error({ err: xeroErr, memberId: member.id }, "Xero sync failed for new member");
    }

    // Send invite email if requested
    if (data.sendInvite) {
      try {
        const token = randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        await prisma.passwordResetToken.create({
          data: { token, memberId: member.id, expiresAt },
        });
        sendPasswordResetEmail(member.email, token).catch((err) => {
          logger.error({ err, memberId: member.id }, "Failed to send invite email");
        });
      } catch (emailErr) {
        logger.error({ err: emailErr, memberId: member.id }, "Failed to create invite token");
      }
    }

    return NextResponse.json(member, { status: 201 });
  } catch (error) {
    logger.error({ err: error }, "Failed to create member");
    return NextResponse.json({ error: "Failed to create member" }, { status: 500 });
  }
}
