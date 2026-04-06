import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeAgeTier } from "@/lib/age-tier";

const updateDependentSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  dateOfBirth: z.string().nullable().optional(),
  ageTier: z.enum(["ADULT", "YOUTH", "CHILD"]).optional(),
  email: z.string().email().optional(),
  inheritParentEmail: z.boolean().optional(),
});

/**
 * PUT /api/members/dependents/[id]
 * Update a dependent's details. Only the parent can do this.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const { id } = await params;

  const dependent = await prisma.member.findUnique({
    where: { id },
    select: { id: true, parentMemberId: true, secondaryParentId: true },
  });

  if (!dependent || (dependent.parentMemberId !== session.user.id && dependent.secondaryParentId !== session.user.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateDependentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const updateData: Record<string, unknown> = {};
  if (parsed.data.firstName) updateData.firstName = parsed.data.firstName.trim();
  if (parsed.data.lastName) updateData.lastName = parsed.data.lastName.trim();

  // Handle email inheritance toggle
  if (parsed.data.inheritParentEmail !== undefined) {
    updateData.inheritParentEmail = parsed.data.inheritParentEmail;
    if (parsed.data.inheritParentEmail) {
      // Switching to inherit: set email to parent's
      const parent = await prisma.member.findUnique({
        where: { id: dependent.parentMemberId! },
        select: { email: true },
      });
      if (parent) updateData.email = parent.email;
    } else if (parsed.data.email) {
      // Using own email
      updateData.email = parsed.data.email.toLowerCase().trim();
    }
  } else if (parsed.data.email) {
    updateData.email = parsed.data.email.toLowerCase().trim();
  }

  if (parsed.data.dateOfBirth !== undefined) {
    if (parsed.data.dateOfBirth === null) {
      updateData.dateOfBirth = null;
    } else {
      const dob = new Date(parsed.data.dateOfBirth);
      if (isNaN(dob.getTime())) {
        return NextResponse.json({ error: "Invalid date of birth" }, { status: 422 });
      }
      updateData.dateOfBirth = dob;
      updateData.ageTier = computeAgeTier(dob);
    }
  } else if (parsed.data.ageTier) {
    updateData.ageTier = parsed.data.ageTier;
  }

  const updated = await prisma.member.update({
    where: { id },
    data: updateData,
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

  return NextResponse.json(updated);
}

/**
 * DELETE /api/members/dependents/[id]
 * Soft-delete (deactivate) a dependent. Only the parent can do this.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const { id } = await params;

  const dependent = await prisma.member.findUnique({
    where: { id },
    select: { id: true, parentMemberId: true, secondaryParentId: true },
  });

  if (!dependent || (dependent.parentMemberId !== session.user.id && dependent.secondaryParentId !== session.user.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.member.update({
    where: { id },
    data: { active: false },
  });

  return NextResponse.json({ success: true });
}
