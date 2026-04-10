import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import logger from "@/lib/logger";
import { logAudit } from "@/lib/audit";

const createSchema = z.object({
  role: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  phone: z.string().min(1).max(50),
  email: z.string().email().max(200).nullish(),
  contactKey: z.string().max(50).nullish(),
  description: z.string().min(1).max(500),
  sortOrder: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
});

/**
 * GET /api/admin/committee
 * List all committee members ordered by sortOrder.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const members = await prisma.committeeMember.findMany({
    orderBy: { sortOrder: "asc" },
  });

  return NextResponse.json({ members });
}

/**
 * POST /api/admin/committee
 * Create a new committee member.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const contactKey = parsed.data.contactKey ?? null;
  if (contactKey) {
    const existing = await prisma.committeeMember.findUnique({
      where: { contactKey },
    });
    if (existing) {
      return NextResponse.json(
        { error: `Contact key "${contactKey}" is already in use` },
        { status: 409 }
      );
    }
  }

  try {
    const member = await prisma.committeeMember.create({
      data: {
        role: parsed.data.role,
        name: parsed.data.name,
        phone: parsed.data.phone,
        email: parsed.data.email ?? null,
        contactKey,
        description: parsed.data.description,
        sortOrder: parsed.data.sortOrder,
        active: parsed.data.active,
      },
    });

    logAudit({
      action: "COMMITTEE_MEMBER_CREATED",
      memberId: session.user.id,
      targetId: member.id,
      details: JSON.stringify({ role: member.role, name: member.name }),
    });

    logger.info(
      { committeeMemberId: member.id, role: member.role },
      "Committee member created"
    );

    return NextResponse.json({ member }, { status: 201 });
  } catch (err) {
    logger.error({ err }, "Error creating committee member");
    return NextResponse.json(
      { error: "Failed to create committee member" },
      { status: 500 }
    );
  }
}
