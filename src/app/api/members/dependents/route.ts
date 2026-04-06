import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeAgeTier } from "@/lib/age-tier";
import { hash } from "bcryptjs";
import { randomBytes } from "crypto";

const createDependentSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  dateOfBirth: z.string().optional(),
  ageTier: z.enum(["ADULT", "YOUTH", "CHILD"]).optional(),
  email: z.string().email().optional(),
  inheritParentEmail: z.boolean().default(true),
});

/**
 * GET /api/members/dependents
 * List the logged-in member's dependents.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const dependents = await prisma.member.findMany({
    where: {
      OR: [
        { parentMemberId: session.user.id },
        { secondaryParentId: session.user.id },
      ],
      active: true,
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      ageTier: true,
      dateOfBirth: true,
      email: true,
      inheritParentEmail: true,
      xeroContactId: true,
    },
    orderBy: { firstName: "asc" },
  });

  return NextResponse.json({ dependents });
}

/**
 * POST /api/members/dependents
 * Create a new dependent for the logged-in member.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createDependentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const parent = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: { email: true, parentMemberId: true },
  });

  if (!parent || parent.parentMemberId) {
    return NextResponse.json(
      { error: "Only primary account holders can add dependents" },
      { status: 403 }
    );
  }

  let ageTier = parsed.data.ageTier || "ADULT";
  let dateOfBirth: Date | null = null;
  if (parsed.data.dateOfBirth) {
    dateOfBirth = new Date(parsed.data.dateOfBirth);
    if (isNaN(dateOfBirth.getTime())) {
      return NextResponse.json({ error: "Invalid date of birth" }, { status: 422 });
    }
    ageTier = computeAgeTier(dateOfBirth);
  }

  // Determine email: use own email or inherit parent's
  const inheritEmail = parsed.data.inheritParentEmail !== false;
  let dependentEmail = parent.email;
  if (!inheritEmail && parsed.data.email) {
    dependentEmail = parsed.data.email.toLowerCase().trim();
  }

  const placeholderHash = await hash(randomBytes(32).toString("hex"), 13);

  const dependent = await prisma.member.create({
    data: {
      email: dependentEmail,
      firstName: parsed.data.firstName.trim(),
      lastName: parsed.data.lastName.trim(),
      passwordHash: placeholderHash,
      ageTier: ageTier as "ADULT" | "YOUTH" | "CHILD",
      dateOfBirth,
      active: true,
      emailVerified: true,
      parentMemberId: session.user.id,
      inheritParentEmail: inheritEmail,
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      ageTier: true,
      dateOfBirth: true,
      email: true,
      inheritParentEmail: true,
    },
  });

  return NextResponse.json(dependent, { status: 201 });
}
