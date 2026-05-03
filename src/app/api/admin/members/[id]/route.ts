import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { getSeasonYear } from "@/lib/utils";
import {
  getXeroContactGroupMemberships,
  isXeroConnected,
  syncManagedXeroContactGroupForMember,
  updateXeroContact,
} from "@/lib/xero";
import {
  buildXeroContactUpdatePayload,
  hasMemberXeroContactChanges,
} from "@/lib/xero-contact-sync";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import logger from "@/lib/logger";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
import {
  copyStreetAddressToPostal,
  POSTAL_ADDRESS_FIELDS,
} from "@/lib/member-address";
import { validateInheritEmailSource } from "@/lib/member-email-inheritance";

const maxStr = (len: number) => z.string().max(len).optional().nullable();

const updateMemberSchema = z.object({
  firstName: z.string().min(1, "First name is required").max(100).transform((s) => s.replace(/[\r\n]/g, " ").trim()).optional(),
  lastName: z.string().min(1, "Last name is required").max(100).transform((s) => s.replace(/[\r\n]/g, " ").trim()).optional(),
  email: z.string().email("Invalid email address").optional(),
  phoneCountryCode: z.string().max(5).optional().nullable(),
  phoneAreaCode: z.string().max(5).optional().nullable(),
  phoneNumber: z.string().max(15).optional().nullable(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format")
    .optional()
    .nullable()
    .or(z.literal("")),
  role: z.enum(["MEMBER", "ADMIN"]).optional(),
  financeAccessLevel: z.enum(["NONE", "VIEWER", "MANAGER"]).optional(),
  ageTier: z.enum(["ADULT", "YOUTH", "CHILD", "INFANT"]).optional(),
  active: z.boolean().optional(),
  canLogin: z.boolean().optional(),
  forcePasswordChange: z.boolean().optional(),
  inheritEmailFromId: z.string().optional().nullable().or(z.literal("")),
  joinedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format")
    .optional()
    .nullable()
    .or(z.literal("")),
  // Addresses
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

const PHONE_FIELDS = ["phoneCountryCode", "phoneAreaCode", "phoneNumber"] as const;
const ADDRESS_FIELDS = [
  "streetAddressLine1", "streetAddressLine2", "streetCity", "streetRegion", "streetPostalCode", "streetCountry",
  "postalAddressLine1", "postalAddressLine2", "postalCity", "postalRegion", "postalPostalCode", "postalCountry",
] as const;

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
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
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
        phoneCountryCode: true,
        phoneAreaCode: true,
        phoneNumber: true,
        dateOfBirth: true,
        role: true,
        financeAccessLevel: true,
        ageTier: true,
        active: true,
        canLogin: true,
        forcePasswordChange: true,
        parentMemberId: true,
        inheritParentEmail: true,
        inheritEmailFromId: true,
        inheritEmailFrom: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        xeroContactId: true,
        joinedDate: true,
        createdAt: true,
        streetAddressLine1: true,
        streetAddressLine2: true,
        streetCity: true,
        streetRegion: true,
        streetPostalCode: true,
        streetCountry: true,
        postalAddressLine1: true,
        postalAddressLine2: true,
        postalCity: true,
        postalRegion: true,
        postalPostalCode: true,
        postalCountry: true,
        familyGroupMemberships: {
          select: {
            familyGroupId: true,
            familyGroup: { select: { id: true, name: true } },
          },
        },
        subscriptions: {
          orderBy: { seasonYear: "desc" },
        },
        dependents: {
          orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
          select: {
            id: true,
            firstName: true,
            lastName: true,
            ageTier: true,
            active: true,
            dateOfBirth: true,
            canLogin: true,
          },
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

  let xeroContactGroups: Array<{ id: string; name: string }> = [];
  let xeroContactGroupsLoaded = !member.xeroContactId;
  if (member.xeroContactId) {
    try {
      const memberships = await getXeroContactGroupMemberships([
        member.xeroContactId,
      ]);
      xeroContactGroups = memberships[member.xeroContactId] ?? [];
      xeroContactGroupsLoaded = Object.prototype.hasOwnProperty.call(
        memberships,
        member.xeroContactId
      );
    } catch (error) {
      const xeroError = getXeroApiErrorInfo(error, "Failed to fetch Xero contact groups for member detail");
      if (!xeroError.handled) {
        logger.error(
          { err: error, memberId: id },
          "Failed to fetch Xero contact groups for member detail"
        );
      }
    }
  }

  return NextResponse.json({
    ...member,
    familyGroups: member.familyGroupMemberships.map((fg) => ({
      id: fg.familyGroup.id,
      name: fg.familyGroup.name,
    })),
    familyGroupMemberships: undefined,
    bookings,
    auditLogs,
    xeroContactGroups,
    xeroContactGroupsLoaded,
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
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
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

  if (id === session.user.id) {
    if (data.role === "MEMBER") {
      return NextResponse.json(
        { error: "You cannot demote your own admin account" },
        { status: 400 }
      );
    }

    if (data.active === false) {
      return NextResponse.json(
        { error: "You cannot deactivate your own account" },
        { status: 400 }
      );
    }

    if (data.canLogin === false) {
      return NextResponse.json(
        { error: "You cannot disable login for your own admin account" },
        { status: 400 }
      );
    }
  }

  // Check email uniqueness if changing email for a canLogin member
  const effectiveCanLogin = data.canLogin !== undefined ? data.canLogin : existing.canLogin;
  if (data.email && data.email.toLowerCase() !== existing.email && effectiveCanLogin) {
    const emailTaken = await prisma.member.findFirst({
      where: { email: data.email.toLowerCase(), canLogin: true, id: { not: id } },
    });
    if (emailTaken) {
      return NextResponse.json(
        { error: "A member with this email already exists" },
        { status: 409 }
      );
    }
  }

  if (data.inheritEmailFromId !== undefined && data.inheritEmailFromId !== "") {
    const inheritEmailFromId = data.inheritEmailFromId?.trim();
    if (inheritEmailFromId) {
      const validation = await validateInheritEmailSource({
        memberId: id,
        inheritEmailFromId,
      });
      if (!validation.ok) {
        return NextResponse.json(
          { error: validation.error },
          { status: validation.status }
        );
      }
    }
  }

  // Build update data
  const updateData: Record<string, unknown> = {};
  if (data.firstName !== undefined) updateData.firstName = data.firstName.trim();
  if (data.lastName !== undefined) updateData.lastName = data.lastName.trim();
  for (const f of PHONE_FIELDS) {
    if (data[f] !== undefined) updateData[f] = data[f]?.trim() || null;
  }
  for (const f of ADDRESS_FIELDS) {
    if (data[f] !== undefined) updateData[f] = data[f]?.trim() || null;
  }
  if (data.role !== undefined) updateData.role = data.role;
  if (data.financeAccessLevel !== undefined) {
    updateData.financeAccessLevel = data.financeAccessLevel;
  }
  if (data.active !== undefined) updateData.active = data.active;
  if (data.canLogin !== undefined) updateData.canLogin = data.canLogin;
  if (data.forcePasswordChange !== undefined) updateData.forcePasswordChange = data.forcePasswordChange;
  if (data.inheritEmailFromId !== undefined) {
    updateData.inheritEmailFromId = data.inheritEmailFromId?.trim() || null;
  }

  if (data.postalSameAsPhysical) {
    const copiedPostalAddress = copyStreetAddressToPostal({
      streetAddressLine1: data.streetAddressLine1,
      streetAddressLine2: data.streetAddressLine2,
      streetCity: data.streetCity,
      streetRegion: data.streetRegion,
      streetPostalCode: data.streetPostalCode,
      streetCountry: data.streetCountry,
    });

    for (const field of POSTAL_ADDRESS_FIELDS) {
      updateData[field] = copiedPostalAddress[field]?.trim() || null;
    }
  }

  // Handle email
  if (data.email !== undefined) {
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
        phoneCountryCode: true,
        phoneAreaCode: true,
        phoneNumber: true,
        dateOfBirth: true,
        role: true,
        financeAccessLevel: true,
        ageTier: true,
        active: true,
        canLogin: true,
        parentMemberId: true,
        inheritParentEmail: true,
        inheritEmailFromId: true,
        xeroContactId: true,
        joinedDate: true,
        createdAt: true,
        streetAddressLine1: true,
        streetAddressLine2: true,
        streetCity: true,
        streetRegion: true,
        streetPostalCode: true,
        streetCountry: true,
        postalAddressLine1: true,
        postalAddressLine2: true,
        postalCity: true,
        postalRegion: true,
        postalPostalCode: true,
        postalCountry: true,
      },
    });

    const needsContactUpdate =
      updated.xeroContactId &&
      hasMemberXeroContactChanges(existing, updated);
    const needsContactGroupSync =
      updated.xeroContactId && existing.ageTier !== updated.ageTier;

    if (updated.xeroContactId && (needsContactUpdate || needsContactGroupSync)) {
      try {
        if (await isXeroConnected()) {
          if (needsContactUpdate) {
            await updateXeroContact(
              updated.xeroContactId,
              buildXeroContactUpdatePayload(updated),
              {
                localModel: "Member",
                localId: id,
                createdByMemberId: session.user.id,
              }
            );
          }

          if (needsContactGroupSync) {
            await syncManagedXeroContactGroupForMember(id, {
              createdByMemberId: session.user.id,
            });
          }
        }
      } catch (xeroErr) {
        logger.error({ err: xeroErr, memberId: id }, "Xero sync failed for member update");
      }
    }

    return NextResponse.json(updated);
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: "A member with this email already exists" },
        { status: 409 }
      );
    }

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
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
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
