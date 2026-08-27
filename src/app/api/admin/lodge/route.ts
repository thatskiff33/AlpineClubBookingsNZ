import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";
import { nameField } from "@/lib/zod-helpers";
import { clubDomainEmail } from "@/config/club-identity";
import { ensureMemberAccessRolesFromCompatibilityFields } from "@/lib/member-access-role-writes";
import { clubTimeZone } from "@/lib/club-time/server";
import { clubSeasonYear } from "@/lib/financial-year";
import { ensureDefaultSeasonSubscriptionForNewMember } from "@/lib/member-subscription-defaults";
import { isFullAdmin } from "@/lib/access-roles";
import { getDefaultLodgeId } from "@/lib/lodges";

// Multi-lodge kiosks: each kiosk login binds to its lodge via a single
// MemberLodgeAccess STAFF grant (getStaffLodgeBinding in lodge-auth.ts);
// an unbound account serves the club's default lodge. This route manages
// every LODGE-role account: the legacy shape (one account, `lodge` key)
// is preserved for existing clients, with `accounts` alongside.

const KIOSK_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  financeAccessLevel: true,
  canLogin: true,
  createdAt: true,
  updatedAt: true,
  lodgeAccess: {
    where: { kind: "STAFF" as const },
    select: { lodgeId: true, lodge: { select: { name: true } } },
  },
} as const;

type KioskRow = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  createdAt: Date;
  updatedAt: Date;
  lodgeAccess: Array<{ lodgeId: string; lodge: { name: string } }>;
};

function serializeKioskAccount(row: KioskRow) {
  const base = {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  // Two or more STAFF grants is ambiguous: getStaffLodgeBinding reports it as
  // such and the kiosk/PIN paths DENY it (M5). Surface the ambiguous state so
  // an admin sees what to fix instead of a misleading unbound "Default lodge"
  // account. The extra fields are added only for this case, so single-grant
  // and zero-grant payloads stay byte-identical.
  if (row.lodgeAccess.length >= 2) {
    return {
      ...base,
      boundLodgeId: null,
      boundLodgeName: null,
      binding: "ambiguous" as const,
      assignedLodgeCount: row.lodgeAccess.length,
    };
  }
  // Exactly one STAFF grant = bound to that lodge; zero grants = null (the
  // kiosk serves the default lodge).
  const binding = row.lodgeAccess.length === 1 ? row.lodgeAccess[0] : null;
  return {
    ...base,
    boundLodgeId: binding?.lodgeId ?? null,
    boundLodgeName: binding?.lodge.name ?? null,
  };
}

async function validateBindingLodge(lodgeId: string) {
  const lodge = await prisma.lodge.findUnique({
    where: { id: lodgeId },
    select: { active: true },
  });
  return Boolean(lodge?.active);
}

async function replaceStaffBinding(
  memberId: string,
  lodgeId: string | null,
  createdById: string,
) {
  await prisma.$transaction(async (tx) => {
    await tx.memberLodgeAccess.deleteMany({
      where: { memberId, kind: "STAFF" },
    });
    if (lodgeId) {
      await tx.memberLodgeAccess.create({
        data: { memberId, lodgeId, kind: "STAFF", createdById },
      });
    }
  });
}

const LODGE_ACCOUNT_EMAIL = clubDomainEmail("lodge");

function serializeLodge(lodge: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  createdAt?: Date;
  updatedAt: Date;
}) {
  return {
    id: lodge.id,
    email: lodge.email,
    firstName: lodge.firstName,
    lastName: lodge.lastName,
    ...(lodge.createdAt ? { createdAt: lodge.createdAt } : {}),
    updatedAt: lodge.updatedAt,
  };
}

/**
 * GET /api/admin/lodge
 * Returns the lodge account details. Auto-creates if missing.
 */
export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let accounts = await prisma.member.findMany({
    where: { role: "LODGE" },
    select: KIOSK_SELECT,
    orderBy: { createdAt: "asc" },
  });
  let lodge = accounts[0] ?? null;

  if (!lodge) {
    // Auto-create the lodge account with a random password (admin must set via UI)
    const randomPassword = crypto.randomBytes(24).toString("base64url");
    const passwordHash = await bcrypt.hash(randomPassword, 12);
    lodge = await prisma.member.create({
      data: {
        email: LODGE_ACCOUNT_EMAIL,
        passwordHash,
        firstName: "Lodge",
        lastName: "Kiosk",
        role: "LODGE",
        financeAccessLevel: "NONE",
        ageTier: "ADULT",
        // canLogin must be true or the credentials login flow rejects the
        // kiosk account outright.
        canLogin: true,
        emailVerified: true,
        forcePasswordChange: true,
      },
      select: KIOSK_SELECT,
    });
    // LODGE accounts resolve to the NOT_REQUIRED built-in LODGE type, so seed a
    // NOT_REQUIRED current-season row (#2149).
    await ensureDefaultSeasonSubscriptionForNewMember(
      prisma,
      { id: lodge.id, role: "LODGE" },
      // The CLUB's current season, from its persisted zone (#2870). The season is
      // required rather than defaulted so no caller can resolve it from inside
      // somebody else's transaction; this route holds no transaction and reads it
      // through the request-cached server binding.
      clubSeasonYear(await clubTimeZone()),
    );
    logAudit({
      action: "LODGE_ACCOUNT_CREATED",
      category: "lodge",
      memberId: session.user.id,
      targetId: lodge.id,
      // `Member`, NOT `Lodge` (#2581). The local is called `lodge` but it holds
      // a kiosk `Member` row with `role: "LODGE"` — this route creates and
      // edits kiosk LOGINS, not lodges. `entityType: "Lodge"` already has a
      // meaning in this tree (`display/lodge-config` writes it with a real
      // `Lodge` id), so putting a Member id behind it would poison entity
      // correlation for both.
      entityType: "Member",
      entityId: lodge.id,
      details: "Auto-created lodge account",
    });
    accounts = await prisma.member.findMany({
      where: { role: "LODGE" },
      select: KIOSK_SELECT,
      orderBy: { createdAt: "asc" },
    });
    lodge = accounts[0];
  }

  await ensureMemberAccessRolesFromCompatibilityFields(prisma, {
    memberId: lodge.id,
    role: lodge.role,
    financeAccessLevel: lodge.financeAccessLevel,
    canLogin: lodge.canLogin,
  });

  // Name of the lodge an unbound kiosk account falls back to, so the admin UI
  // can warn which lodge an unbound account would actually serve (issue #23).
  const defaultLodgeId = await getDefaultLodgeId(prisma);
  const defaultLodge = await prisma.lodge.findUnique({
    where: { id: defaultLodgeId },
    select: { name: true },
  });

  return NextResponse.json({
    // Legacy single-account shape, kept for existing clients.
    lodge: serializeLodge(lodge),
    accounts: accounts.map((account) => serializeKioskAccount(account)),
    defaultLodgeName: defaultLodge?.name ?? null,
  });
}

const updateSchema = z.object({
  // Kiosk account to update; omitted targets the first (legacy clients).
  id: z.string().min(1).optional(),
  email: z.string().email().optional(),
  password: z.string().min(6).optional(),
  firstName: nameField().optional(),
  lastName: nameField().optional(),
  // Lodge this kiosk operates: a string rebinds, null unbinds (the kiosk
  // then serves the club's default lodge), omitted leaves it untouched.
  lodgeId: z.string().min(1).nullable().optional(),
});

/**
 * PUT /api/admin/lodge
 * Updates the lodge account email and/or password.
 */
export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const body = await request.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { email, password, firstName, lastName, lodgeId } = parsed.data;

  const lodge = await prisma.member.findFirst({
    where: { role: "LODGE", ...(parsed.data.id ? { id: parsed.data.id } : {}) },
    orderBy: { createdAt: "asc" },
  });

  if (!lodge) {
    return NextResponse.json({ error: "Lodge account not found" }, { status: 404 });
  }

  if (lodgeId !== undefined && !isFullAdmin(session.user)) {
    // Rebinding replaces MemberLodgeAccess STAFF grants — an access-role
    // write under the upstream #1012 separation-of-duties rule.
    return NextResponse.json(
      { error: "Full Admin access is required to change a kiosk's lodge" },
      { status: 403 },
    );
  }

  if (typeof lodgeId === "string" && !(await validateBindingLodge(lodgeId))) {
    return NextResponse.json(
      { error: "Lodge not found or not active" },
      { status: 400 },
    );
  }

  // Check email uniqueness if changing email
  if (email && email.toLowerCase() !== lodge.email) {
    const existing = await prisma.member.findFirst({
      where: { email: email.toLowerCase(), id: { not: lodge.id } },
    });
    if (existing) {
      return NextResponse.json({ error: "Email already in use" }, { status: 409 });
    }
  }

  const updateData: Record<string, unknown> = {};
  const changes: string[] = [];

  if (email) {
    updateData.email = email.toLowerCase();
    changes.push(`email changed to ${email.toLowerCase()}`);
  }
  if (password) {
    updateData.passwordHash = await bcrypt.hash(password, 12);
    changes.push("password changed");
  }
  if (firstName) {
    updateData.firstName = firstName;
    changes.push(`firstName changed to ${firstName}`);
  }
  if (lastName) {
    updateData.lastName = lastName;
    changes.push(`lastName changed to ${lastName}`);
  }

  if (lodgeId !== undefined) {
    changes.push(
      lodgeId ? `bound to lodge ${lodgeId}` : "unbound (default lodge)",
    );
  }

  if (changes.length === 0) {
    return NextResponse.json({ error: "No changes provided" }, { status: 400 });
  }

  updateData.financeAccessLevel = "NONE";

  if (lodgeId !== undefined) {
    await replaceStaffBinding(lodge.id, lodgeId, session.user.id);
  }

  const updated = await prisma.member.update({
    where: { id: lodge.id },
    data: updateData,
    select: KIOSK_SELECT,
  });

  logAudit({
    action: "LODGE_ACCOUNT_UPDATED",
    category: "lodge",
    memberId: session.user.id,
    targetId: lodge.id,
    // The kiosk Member row, as above — `lodge` is a Member, not a Lodge.
    entityType: "Member",
    entityId: lodge.id,
    details: changes.join("; "),
  });

  return NextResponse.json({
    lodge: serializeLodge(updated),
    account: serializeKioskAccount(updated),
  });
}

const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  firstName: nameField().optional(),
  lastName: nameField().optional(),
  lodgeId: z.string().min(1).optional(),
});

/**
 * POST /api/admin/lodge
 * Creates an additional kiosk account (multi-lodge: one shared login per
 * lodge device), optionally bound to a lodge via a STAFF grant.
 */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  // Separation of duties (upstream #1012): creating an account that holds
  // the privileged LODGE access role is an access-role write, so scoped
  // admins may not do it.
  if (!isFullAdmin(session.user)) {
    return NextResponse.json(
      { error: "Full Admin access is required to create kiosk accounts" },
      { status: 403 },
    );
  }
  const body = await request.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const email = parsed.data.email.toLowerCase();
  const existing = await prisma.member.findFirst({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "Email already in use" }, { status: 409 });
  }
  if (parsed.data.lodgeId && !(await validateBindingLodge(parsed.data.lodgeId))) {
    return NextResponse.json(
      { error: "Lodge not found or not active" },
      { status: 400 },
    );
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const created = await prisma.$transaction(async (tx) => {
    const member = await tx.member.create({
      data: {
        email,
        passwordHash,
        firstName: parsed.data.firstName ?? "Lodge",
        lastName: parsed.data.lastName ?? "Kiosk",
        role: "LODGE",
        financeAccessLevel: "NONE",
        ageTier: "ADULT",
        // canLogin must be true or the credentials login flow rejects the
        // kiosk account outright (matching the auto-created account).
        canLogin: true,
        emailVerified: true,
      },
      select: { id: true },
    });
    if (parsed.data.lodgeId) {
      await tx.memberLodgeAccess.create({
        data: {
          memberId: member.id,
          lodgeId: parsed.data.lodgeId,
          kind: "STAFF",
          createdById: session.user.id,
        },
      });
    }
    return member;
  });

  // LODGE accounts resolve to the NOT_REQUIRED built-in LODGE type (#2149);
  // normalized access rows mirror the compatibility fields (same as the
  // auto-create path).
  await ensureDefaultSeasonSubscriptionForNewMember(
    prisma,
    { id: created.id, role: "LODGE" },
    clubSeasonYear(await clubTimeZone()),
  );
  await ensureMemberAccessRolesFromCompatibilityFields(prisma, {
    memberId: created.id,
    role: "LODGE",
    financeAccessLevel: "NONE",
    canLogin: true,
  });

  logAudit({
    action: "LODGE_ACCOUNT_CREATED",
    category: "lodge",
    memberId: session.user.id,
    targetId: created.id,
    // The kiosk Member row, as above. The optional `lodgeId` is the BINDING
    // target rather than the subject of the event, and it is absent for an
    // unbound kiosk, so it is not the entity.
    entityType: "Member",
    entityId: created.id,
    details: `Created kiosk account ${email}${parsed.data.lodgeId ? ` bound to lodge ${parsed.data.lodgeId}` : ""}`,
  });

  const row = await prisma.member.findUniqueOrThrow({
    where: { id: created.id },
    select: KIOSK_SELECT,
  });
  return NextResponse.json({ account: serializeKioskAccount(row) }, { status: 201 });
}
