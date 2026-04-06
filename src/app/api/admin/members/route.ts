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
  parentMemberId: z.string().optional().nullable(),
  secondaryParentId: z.string().optional().nullable(),
  familyGroupId: z.string().optional().nullable(),
  inheritParentEmail: z.boolean().default(true),
});

const SORT_BY_WHITELIST = ["name", "email", "role", "ageTier", "active", "createdAt"] as const;

/**
 * GET /api/admin/members
 * List members with search, filtering, sorting, and pagination.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const q = sp.get("q") || undefined;

  // Pagination
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(sp.get("pageSize") || "25", 10) || 25));

  // Sorting
  const sortByRaw = sp.get("sortBy") || "name";
  const sortBy = (SORT_BY_WHITELIST as readonly string[]).includes(sortByRaw) ? sortByRaw : "name";
  const sortDir = sp.get("sortDir") === "desc" ? "desc" : "asc";

  // Build orderBy
  let orderBy: Record<string, string>[] | Record<string, string>;
  switch (sortBy) {
    case "name":
      orderBy = [{ lastName: sortDir }, { firstName: sortDir }];
      break;
    case "email":
      orderBy = { email: sortDir };
      break;
    case "role":
      orderBy = { role: sortDir };
      break;
    case "ageTier":
      orderBy = { ageTier: sortDir };
      break;
    case "active":
      orderBy = { active: sortDir };
      break;
    case "createdAt":
      orderBy = { createdAt: sortDir };
      break;
    default:
      orderBy = [{ lastName: "asc" }, { firstName: "asc" }];
  }

  const currentSeasonYear = getSeasonYear(new Date());

  // Build where clause
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};
  const andConditions: Record<string, unknown>[] = [];

  // Text search
  if (q) {
    andConditions.push({
      OR: [
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ],
    });
  }

  // Filter: role
  const roleFilter = sp.get("role");
  if (roleFilter && (roleFilter === "MEMBER" || roleFilter === "ADMIN")) {
    andConditions.push({ role: roleFilter });
  }

  // Filter: active
  const activeFilter = sp.get("active");
  if (activeFilter === "true") {
    andConditions.push({ active: true });
  } else if (activeFilter === "false") {
    andConditions.push({ active: false });
  }

  // Filter: ageTier
  const ageTierFilter = sp.get("ageTier");
  if (ageTierFilter && ["ADULT", "YOUTH", "CHILD"].includes(ageTierFilter)) {
    andConditions.push({ ageTier: ageTierFilter });
  }

  // Filter: xeroLinked
  const xeroLinkedFilter = sp.get("xeroLinked");
  if (xeroLinkedFilter === "true") {
    andConditions.push({ xeroContactId: { not: null } });
  } else if (xeroLinkedFilter === "false") {
    andConditions.push({ xeroContactId: null });
  }

  // Filter: member type (primary vs dependent)
  const typeFilter = sp.get("type");
  if (typeFilter === "primary") {
    andConditions.push({ parentMemberId: null });
  } else if (typeFilter === "dependent") {
    andConditions.push({ parentMemberId: { not: null } });
  }

  // Filter: subscription
  const subscriptionFilter = sp.get("subscription");
  if (subscriptionFilter === "NONE") {
    andConditions.push({
      subscriptions: { none: { seasonYear: currentSeasonYear } },
    });
  } else if (
    subscriptionFilter &&
    ["PAID", "UNPAID", "OVERDUE", "NOT_INVOICED"].includes(subscriptionFilter)
  ) {
    andConditions.push({
      subscriptions: {
        some: { seasonYear: currentSeasonYear, status: subscriptionFilter },
      },
    });
  }

  if (andConditions.length > 0) {
    where.AND = andConditions;
  }

  // Filter: family group
  const familyGroupFilter = sp.get("familyGroup");
  if (familyGroupFilter === "none") {
    andConditions.push({ familyGroupId: null });
  } else if (familyGroupFilter === "any") {
    andConditions.push({ familyGroupId: { not: null } });
  } else if (familyGroupFilter && familyGroupFilter !== "all") {
    andConditions.push({ familyGroupId: familyGroupFilter });
  }

  const select = {
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
    forcePasswordChange: true,
    parentMemberId: true,
    inheritParentEmail: true,
    parent: {
      select: { id: true, firstName: true, lastName: true },
    },
    secondaryParentId: true,
    secondaryParent: {
      select: { id: true, firstName: true, lastName: true },
    },
    familyGroupId: true,
    familyGroup: {
      select: { id: true, name: true },
    },
    _count: {
      select: { dependents: true, secondaryDependents: true },
    },
    subscriptions: {
      where: { seasonYear: currentSeasonYear },
      select: { status: true, seasonYear: true, xeroInvoiceId: true },
      take: 1,
    },
  };

  const [members, total] = await Promise.all([
    prisma.member.findMany({
      where,
      orderBy,
      select,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.member.count({ where }),
  ]);

  const membersWithSub = members.map((m) => ({
    ...m,
    subscriptionStatus: m.subscriptions[0]?.status ?? null,
    subscriptionXeroInvoiceId: m.subscriptions[0]?.xeroInvoiceId ?? null,
    parentName: m.parent ? `${m.parent.firstName} ${m.parent.lastName}` : null,
    secondaryParentName: m.secondaryParent ? `${m.secondaryParent.firstName} ${m.secondaryParent.lastName}` : null,
    dependentCount: m._count.dependents + m._count.secondaryDependents,
    familyGroupName: m.familyGroup?.name ?? null,
    subscriptions: undefined,
    parent: undefined,
    secondaryParent: undefined,
    familyGroup: undefined,
    _count: undefined,
  }));

  return NextResponse.json({
    members: membersWithSub,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
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
  let email = data.email.toLowerCase().trim();

  // Validate parent assignment
  if (data.parentMemberId) {
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
    // Dependents share parent's email unless they have their own
    if (data.inheritParentEmail !== false) {
      email = parent.email;
    }
  }

  if (data.secondaryParentId) {
    if (!data.parentMemberId) {
      return NextResponse.json({ error: "Primary parent is required when setting a secondary parent" }, { status: 422 });
    }
    if (data.secondaryParentId === data.parentMemberId) {
      return NextResponse.json({ error: "Secondary parent must be different from primary parent" }, { status: 422 });
    }
    const secondaryParent = await prisma.member.findUnique({ where: { id: data.secondaryParentId } });
    if (!secondaryParent) {
      return NextResponse.json({ error: "Secondary parent not found" }, { status: 404 });
    }
    if (!secondaryParent.active) {
      return NextResponse.json({ error: "Secondary parent is inactive" }, { status: 422 });
    }
    if (secondaryParent.parentMemberId) {
      return NextResponse.json({ error: "Secondary parent cannot be a dependent" }, { status: 422 });
    }
  }

  // Validate family group assignment (only for primary members)
  if (data.familyGroupId) {
    if (data.parentMemberId) {
      return NextResponse.json({ error: "Dependents cannot be assigned to a family group" }, { status: 422 });
    }
    const group = await prisma.familyGroup.findUnique({ where: { id: data.familyGroupId } });
    if (!group) {
      return NextResponse.json({ error: "Family group not found" }, { status: 404 });
    }
  }

  // Check for existing member (only for primary members)
  if (!data.parentMemberId) {
    const existing = await prisma.member.findFirst({ where: { email, parentMemberId: null } });
    if (existing) {
      return NextResponse.json(
        { error: "A member with this email already exists" },
        { status: 409 }
      );
    }
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
        parentMemberId: data.parentMemberId || null,
        secondaryParentId: data.secondaryParentId || null,
        familyGroupId: data.familyGroupId || null,
        inheritParentEmail: data.parentMemberId ? data.inheritParentEmail : true,
        emailVerified: data.parentMemberId ? true : false, // Dependents don't need verification
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
        joinedDate: true,
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
    let inviteWarning: string | undefined;
    if (data.sendInvite) {
      try {
        const token = randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        await prisma.passwordResetToken.create({
          data: { token, memberId: member.id, expiresAt },
        });
        await sendPasswordResetEmail(member.email, token);
      } catch (emailErr) {
        logger.error({ err: emailErr, memberId: member.id }, "Failed to send invite email");
        inviteWarning = `Member created but invite email failed to send: ${emailErr instanceof Error ? emailErr.message : String(emailErr)}`;
      }
    }

    return NextResponse.json(
      { ...member, ...(inviteWarning ? { warning: inviteWarning } : {}) },
      { status: 201 },
    );
  } catch (error) {
    logger.error({ err: error }, "Failed to create member");
    return NextResponse.json({ error: "Failed to create member" }, { status: 500 });
  }
}
