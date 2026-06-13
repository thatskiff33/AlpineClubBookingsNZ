import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";
import { nameField } from "@/lib/zod-helpers";
import { clubDomainEmail } from "@/config/club-identity";
import { ensureNotRequiredSubscriptionForRole } from "@/lib/member-subscription-defaults";

const LODGE_ACCOUNT_EMAIL = clubDomainEmail("lodge");

/**
 * GET /api/admin/lodge
 * Returns the lodge account details. Auto-creates if missing.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let lodge = await prisma.member.findFirst({
    where: { role: "LODGE" },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      createdAt: true,
      updatedAt: true,
    },
  });

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
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    // LODGE accounts never owe a membership subscription.
    await ensureNotRequiredSubscriptionForRole(prisma, {
      id: lodge.id,
      role: "LODGE",
    });
    logAudit({
      action: "LODGE_ACCOUNT_CREATED",
      memberId: session.user.id,
      targetId: lodge.id,
      details: "Auto-created lodge account",
    });
  }

  return NextResponse.json({ lodge });
}

const updateSchema = z.object({
  email: z.string().email().optional(),
  password: z.string().min(6).optional(),
  firstName: nameField().optional(),
  lastName: nameField().optional(),
});

/**
 * PUT /api/admin/lodge
 * Updates the lodge account email and/or password.
 */
export async function PUT(request: NextRequest) {
  const guard = await requireAdmin();
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

  const { email, password, firstName, lastName } = parsed.data;

  const lodge = await prisma.member.findFirst({
    where: { role: "LODGE" },
  });

  if (!lodge) {
    return NextResponse.json({ error: "Lodge account not found" }, { status: 404 });
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

  if (changes.length === 0) {
    return NextResponse.json({ error: "No changes provided" }, { status: 400 });
  }

  updateData.financeAccessLevel = "NONE";

  const updated = await prisma.member.update({
    where: { id: lodge.id },
    data: updateData,
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      updatedAt: true,
    },
  });

  logAudit({
    action: "LODGE_ACCOUNT_UPDATED",
    memberId: session.user.id,
    targetId: lodge.id,
    details: changes.join("; "),
  });

  return NextResponse.json({ lodge: updated });
}
