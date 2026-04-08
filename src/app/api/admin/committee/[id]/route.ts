import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import logger from "@/lib/logger";
import { logAudit } from "@/lib/audit";

const updateSchema = z.object({
  role: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(200).optional(),
  phone: z.string().min(1).max(50).optional(),
  email: z.string().email().max(200).nullish(),
  contactKey: z.string().max(50).nullish(),
  description: z.string().min(1).max(500).optional(),
  sortOrder: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

/**
 * PUT /api/admin/committee/[id]
 * Update a committee member.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = await prisma.committeeMember.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const member = await prisma.committeeMember.update({
      where: { id },
      data: {
        ...(parsed.data.role !== undefined && { role: parsed.data.role }),
        ...(parsed.data.name !== undefined && { name: parsed.data.name }),
        ...(parsed.data.phone !== undefined && { phone: parsed.data.phone }),
        ...(parsed.data.email !== undefined && { email: parsed.data.email ?? null }),
        ...(parsed.data.contactKey !== undefined && { contactKey: parsed.data.contactKey ?? null }),
        ...(parsed.data.description !== undefined && { description: parsed.data.description }),
        ...(parsed.data.sortOrder !== undefined && { sortOrder: parsed.data.sortOrder }),
        ...(parsed.data.active !== undefined && { active: parsed.data.active }),
      },
    });

    logAudit({
      action: "COMMITTEE_MEMBER_UPDATED",
      memberId: session.user.id,
      targetId: member.id,
      details: JSON.stringify(parsed.data),
    });

    logger.info(
      { committeeMemberId: member.id },
      "Committee member updated"
    );

    return NextResponse.json({ member });
  } catch (err) {
    logger.error({ err }, "Error updating committee member");
    return NextResponse.json(
      { error: "Failed to update committee member" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/committee/[id]
 * Delete a committee member.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const existing = await prisma.committeeMember.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    await prisma.committeeMember.delete({ where: { id } });

    logAudit({
      action: "COMMITTEE_MEMBER_DELETED",
      memberId: session.user.id,
      targetId: id,
      details: JSON.stringify({ role: existing.role, name: existing.name }),
    });

    logger.info(
      { committeeMemberId: id },
      "Committee member deleted"
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Error deleting committee member");
    return NextResponse.json(
      { error: "Failed to delete committee member" },
      { status: 500 }
    );
  }
}
