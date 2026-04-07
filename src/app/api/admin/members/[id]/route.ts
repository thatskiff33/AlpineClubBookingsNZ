import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { getSeasonYear } from "@/lib/utils";
import { isXeroConnected, updateXeroContact } from "@/lib/xero";
import logger from "@/lib/logger";

const updateMemberSchema = z.object({
  firstName: z.string().min(1, "First name is required").max(100).transform((s) => s.replace(/[\r\n]/g, " ").trim()).optional(),
  lastName: z.string().min(1, "Last name is required").max(100).transform((s) => s.replace(/[\r\n]/g, " ").trim()).optional(),
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
  joinedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format")
    .optional()
    .nullable()
    .or(z.literal("")),
  parentMemberId: z.string().optional().nullable(),
  secondaryParentId: z.string().optional().nullable(),
  familyGroupId: z.string().optional().nullable(),
  inheritParentEmail: z.boolean().optional(),
  inheritEmailFromId: z.string().optional().nullable(),
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
        joinedDate: true,
        createdAt: true,
        parentMemberId: true,
        inheritParentEmail: true,
        parent: { select: { id: true, firstName: true, lastName: true } },
        secondaryParentId: true,
        secondaryParent: { select: { id: true, firstName: true, lastName: true } },
        inheritEmailFromId: true,
        inheritEmailFrom: { select: { id: true, firstName: true, lastName: true, email: true } },
        familyGroupId: true,
        familyGroup: { select: { id: true, name: true } },
        _count: { select: { dependents: true, secondaryDependents: true } },
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

  // Check email uniqueness if changing (skip if assigning a parent, since dependent email comes from parent)
  const isBecomingDependent = data.parentMemberId && data.parentMemberId !== null;
  if (data.email && data.email.toLowerCase() !== existing.email && !isBecomingDependent) {
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

  // Validate parent assignment changes
  if (data.parentMemberId !== undefined) {
    if (data.parentMemberId === null) {
      // Unlinking: converting dependent to primary - require a unique email
      if (existing.parentMemberId) {
        const newEmail = data.email?.toLowerCase().trim();
        if (!newEmail) {
          return NextResponse.json(
            { error: "Email is required when converting a dependent to a primary member" },
            { status: 422 }
          );
        }
        const emailTaken = await prisma.member.findFirst({
          where: { email: newEmail, parentMemberId: null, id: { not: id } },
        });
        if (emailTaken) {
          return NextResponse.json({ error: "A primary member with this email already exists" }, { status: 409 });
        }
      }
    } else {
      // Assigning or reassigning parent
      if (data.parentMemberId === id) {
        return NextResponse.json({ error: "A member cannot be their own parent" }, { status: 422 });
      }
      const parent = await prisma.member.findUnique({ where: { id: data.parentMemberId } });
      if (!parent) {
        return NextResponse.json({ error: "Primary parent not found" }, { status: 404 });
      }
      if (!parent.active) {
        return NextResponse.json({ error: "Primary parent is inactive" }, { status: 422 });
      }
      if (parent.parentMemberId) {
        return NextResponse.json({ error: "Primary parent cannot be a dependent" }, { status: 422 });
      }
      // If member currently has dependents, block conversion to dependent
      if (!existing.parentMemberId) {
        const depCount = await prisma.member.count({
          where: { OR: [{ parentMemberId: id }, { secondaryParentId: id }] },
        });
        if (depCount > 0) {
          return NextResponse.json(
            { error: "Cannot convert to dependent: this member has dependents. Reassign them first." },
            { status: 422 }
          );
        }
      }
    }
  }

  // Validate inheritEmailFromId
  if (data.inheritEmailFromId !== undefined && data.inheritEmailFromId !== null) {
    if (data.inheritEmailFromId === id) {
      return NextResponse.json({ error: "A member cannot inherit email from themselves" }, { status: 422 });
    }
    const source = await prisma.member.findUnique({ where: { id: data.inheritEmailFromId } });
    if (!source) {
      return NextResponse.json({ error: "Email source member not found" }, { status: 404 });
    }
    if (source.ageTier !== "ADULT") {
      return NextResponse.json({ error: "Email can only be inherited from an adult member" }, { status: 422 });
    }
    if (!source.active) {
      return NextResponse.json({ error: "Email source member is inactive" }, { status: 422 });
    }
    // Source must be a primary member (not a dependent)
    if (source.parentMemberId !== null) {
      return NextResponse.json(
        { error: "Email can only be inherited from primary members, not dependents" },
        { status: 400 }
      );
    }
  }

  if (data.secondaryParentId !== undefined && data.secondaryParentId !== null) {
    const effectiveParent = data.parentMemberId !== undefined ? data.parentMemberId : existing.parentMemberId;
    if (!effectiveParent) {
      return NextResponse.json({ error: "Primary parent is required when setting a secondary parent" }, { status: 422 });
    }
    if (data.secondaryParentId === id) {
      return NextResponse.json({ error: "A member cannot be their own secondary parent" }, { status: 422 });
    }
    if (data.secondaryParentId === effectiveParent) {
      return NextResponse.json({ error: "Secondary parent must be different from primary parent" }, { status: 422 });
    }
    const secParent = await prisma.member.findUnique({ where: { id: data.secondaryParentId } });
    if (!secParent) {
      return NextResponse.json({ error: "Secondary parent not found" }, { status: 404 });
    }
    if (!secParent.active) {
      return NextResponse.json({ error: "Secondary parent is inactive" }, { status: 422 });
    }
    if (secParent.parentMemberId) {
      return NextResponse.json({ error: "Secondary parent cannot be a dependent" }, { status: 422 });
    }
  }

  // Build update data
  const updateData: Record<string, unknown> = {};
  if (data.firstName !== undefined) updateData.firstName = data.firstName.trim();
  if (data.lastName !== undefined) updateData.lastName = data.lastName.trim();
  if (data.phone !== undefined) updateData.phone = data.phone?.trim() || null;
  if (data.role !== undefined) updateData.role = data.role;
  if (data.active !== undefined) updateData.active = data.active;
  if (data.forcePasswordChange !== undefined) updateData.forcePasswordChange = data.forcePasswordChange;

  // Handle inheritParentEmail
  if (data.inheritParentEmail !== undefined) {
    updateData.inheritParentEmail = data.inheritParentEmail;
  }

  // Handle inheritEmailFromId
  if (data.inheritEmailFromId !== undefined) {
    updateData.inheritEmailFromId = data.inheritEmailFromId;
  }

  // Handle parent assignment
  if (data.parentMemberId !== undefined) {
    updateData.parentMemberId = data.parentMemberId;
    if (data.parentMemberId) {
      // When assigning a parent, set email to parent's email only if inheriting
      const shouldInherit = data.inheritParentEmail !== undefined ? data.inheritParentEmail : existing.inheritParentEmail;
      if (shouldInherit) {
        const parent = await prisma.member.findUnique({ where: { id: data.parentMemberId } });
        if (parent) updateData.email = parent.email;
      }
    }
    if (data.parentMemberId === null) {
      // When unlinking, also clear secondary parent and reset inheritParentEmail
      updateData.secondaryParentId = null;
      updateData.inheritParentEmail = true;
    }
  } else if (data.inheritParentEmail !== undefined && existing.parentMemberId) {
    // Changing inheritParentEmail without changing parent
    if (data.inheritParentEmail) {
      // Switching to inherit: update email to parent's
      const parent = await prisma.member.findUnique({ where: { id: existing.parentMemberId } });
      if (parent) updateData.email = parent.email;
    }
    // If switching to own email, the email field should be provided separately
  }

  // Handle secondary parent
  if (data.secondaryParentId !== undefined) {
    updateData.secondaryParentId = data.secondaryParentId;
  }

  // Handle email (only if not already set by parent assignment)
  if (data.email !== undefined && !updateData.email) {
    updateData.email = data.email.toLowerCase().trim();
  }

  // Handle joinedDate
  if (data.joinedDate !== undefined) {
    if (data.joinedDate && data.joinedDate !== "") {
      const jd = new Date(data.joinedDate);
      if (isNaN(jd.getTime())) {
        return NextResponse.json({ error: "Invalid joined date" }, { status: 422 });
      }
      updateData.joinedDate = jd;
    } else {
      updateData.joinedDate = null;
    }
  }

  // Handle family group assignment
  if (data.familyGroupId !== undefined) {
    const effectiveParent = data.parentMemberId !== undefined ? data.parentMemberId : existing.parentMemberId;
    if (data.familyGroupId && effectiveParent) {
      return NextResponse.json({ error: "Dependents cannot be assigned to a family group" }, { status: 422 });
    }
    if (data.familyGroupId) {
      const group = await prisma.familyGroup.findUnique({ where: { id: data.familyGroupId } });
      if (!group) {
        return NextResponse.json({ error: "Family group not found" }, { status: 404 });
      }
    }
    updateData.familyGroupId = data.familyGroupId;
  }

  // Clear family group if converting to a dependent
  if (data.parentMemberId && data.parentMemberId !== null && existing.familyGroupId && data.familyGroupId === undefined) {
    updateData.familyGroupId = null;
  }

  // Handle DOB and age tier
  if (data.dateOfBirth !== undefined) {
    if (data.dateOfBirth && data.dateOfBirth !== "") {
      const dob = new Date(data.dateOfBirth);
      if (isNaN(dob.getTime())) {
        return NextResponse.json({ error: "Invalid date of birth" }, { status: 422 });
      }
      updateData.dateOfBirth = dob;
      updateData.ageTier = await computeAgeTier(dob, getSeasonStartDate(getSeasonYear()));
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
        joinedDate: true,
        createdAt: true,
        parentMemberId: true,
        inheritParentEmail: true,
        inheritEmailFromId: true,
        secondaryParentId: true,
        familyGroupId: true,
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
