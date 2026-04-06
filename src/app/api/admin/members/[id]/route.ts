import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeAgeTier } from "@/lib/age-tier";
import { isXeroConnected, updateXeroContact } from "@/lib/xero";
import logger from "@/lib/logger";

const updateMemberSchema = z.object({
  firstName: z.string().min(1, "First name is required").max(100).optional(),
  lastName: z.string().min(1, "Last name is required").max(100).optional(),
  email: z.string().email("Invalid email address").optional(),
  phone: z.string().max(20).optional().nullable(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format")
    .optional()
    .nullable()
    .or(z.literal("")),
  role: z.enum(["MEMBER", "ADMIN"]).optional(),
  ageTier: z.enum(["ADULT", "YOUTH", "CHILD"]).optional(),
  active: z.boolean().optional(),
  forcePasswordChange: z.boolean().optional(),
});

/**
 * GET /api/admin/members/[id]
 * Get full member detail including subscriptions, bookings, audit logs, and stats.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const { id } = await params;

  const [member, bookings, auditLogs, stats] = await Promise.all([
    prisma.member.findUnique({
      where: { id },
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
        forcePasswordChange: true,
        xeroContactId: true,
        createdAt: true,
        subscriptions: {
          orderBy: { seasonYear: "desc" },
        },
      },
    }),
    prisma.booking.findMany({
      where: { memberId: id },
      orderBy: { checkIn: "desc" },
      select: {
        id: true,
        checkIn: true,
        checkOut: true,
        status: true,
        finalPriceCents: true,
        _count: { select: { guests: true } },
      },
    }),
    prisma.auditLog.findMany({
      where: {
        OR: [{ memberId: id }, { targetId: id }],
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.booking.aggregate({
      where: {
        memberId: id,
        status: { in: ["CONFIRMED", "COMPLETED"] },
      },
      _sum: { finalPriceCents: true },
      _count: true,
      _max: { checkOut: true },
    }),
  ]);

  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...member,
    bookings,
    auditLogs,
    stats: {
      totalBookings: stats._count,
      totalSpendCents: stats._sum.finalPriceCents || 0,
      lastStay: stats._max.checkOut || null,
    },
  });
}

/**
 * PUT /api/admin/members/[id]
 * Update a member's details. Syncs changes to Xero if connected.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateMemberSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const existing = await prisma.member.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const data = parsed.data;

  // Check email uniqueness if changing
  if (data.email && data.email.toLowerCase() !== existing.email) {
    const emailTaken = await prisma.member.findFirst({
      where: { email: data.email.toLowerCase(), parentMemberId: null, id: { not: id } },
    });
    if (emailTaken) {
      return NextResponse.json(
        { error: "A member with this email already exists" },
        { status: 409 }
      );
    }
  }

  // Build update data
  const updateData: Record<string, unknown> = {};
  if (data.firstName !== undefined) updateData.firstName = data.firstName.trim();
  if (data.lastName !== undefined) updateData.lastName = data.lastName.trim();
  if (data.email !== undefined) updateData.email = data.email.toLowerCase().trim();
  if (data.phone !== undefined) updateData.phone = data.phone?.trim() || null;
  if (data.role !== undefined) updateData.role = data.role;
  if (data.active !== undefined) updateData.active = data.active;
  if (data.forcePasswordChange !== undefined) updateData.forcePasswordChange = data.forcePasswordChange;

  // Handle DOB and age tier
  if (data.dateOfBirth !== undefined) {
    if (data.dateOfBirth && data.dateOfBirth !== "") {
      const dob = new Date(data.dateOfBirth);
      if (isNaN(dob.getTime())) {
        return NextResponse.json({ error: "Invalid date of birth" }, { status: 422 });
      }
      updateData.dateOfBirth = dob;
      updateData.ageTier = computeAgeTier(dob);
    } else {
      updateData.dateOfBirth = null;
      // Use explicit ageTier if provided, otherwise keep existing
      if (data.ageTier) updateData.ageTier = data.ageTier;
    }
  } else if (data.ageTier !== undefined) {
    updateData.ageTier = data.ageTier;
  }

  try {
    const updated = await prisma.member.update({
      where: { id },
      data: updateData,
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

    // Cascade deactivation to dependents
    if (data.active === false) {
      await prisma.member.updateMany({
        where: { parentMemberId: id },
        data: { active: false },
      });
    }

    // Sync to Xero if connected and member has a linked contact
    if (updated.xeroContactId) {
      try {
        if (await isXeroConnected()) {
          await updateXeroContact(updated.xeroContactId, {
            firstName: updated.firstName,
            lastName: updated.lastName,
            email: updated.email,
            phone: updated.phone,
          });
        }
      } catch (xeroErr) {
        logger.error({ err: xeroErr, memberId: id }, "Xero sync failed for member update");
      }
    }

    return NextResponse.json(updated);
  } catch (error) {
    logger.error({ err: error, memberId: id }, "Failed to update member");
    return NextResponse.json({ error: "Failed to update member" }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/members/[id]
 * Soft-delete a member (set active: false).
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const { id } = await params;

  const existing = await prisma.member.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  // Don't let admin deactivate themselves
  if (id === session.user.id) {
    return NextResponse.json(
      { error: "You cannot deactivate your own account" },
      { status: 400 }
    );
  }

  await prisma.member.update({
    where: { id },
    data: { active: false },
  });

  return NextResponse.json({ success: true });
}
