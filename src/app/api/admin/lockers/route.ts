import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";

const createLockerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  allocatedToMemberId: z.string().trim().min(1).max(191).nullable().optional(),
});

/**
 * GET /api/admin/lockers
 * Returns lockers and active members for allocation dropdown.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  const [lockers, members] = await Promise.all([
    prisma.locker.findMany({
      include: {
        allocatedTo: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
      orderBy: { name: "asc" },
    }),
    prisma.member.findMany({
      where: { active: true },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
  ]);

  return NextResponse.json({ lockers, members });
}

/**
 * POST /api/admin/lockers
 * Creates a new locker, optionally allocated to a member.
 */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createLockerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const allocatedToMemberId = parsed.data.allocatedToMemberId ?? null;
  if (allocatedToMemberId) {
    const member = await prisma.member.findUnique({
      where: { id: allocatedToMemberId },
      select: { id: true },
    });
    if (!member) {
      return NextResponse.json(
        { error: "Allocated member not found" },
        { status: 404 },
      );
    }
  }

  const locker = await prisma.locker.create({
    data: {
      name: parsed.data.name,
      allocatedToMemberId,
    },
    include: {
      allocatedTo: {
        select: { id: true, firstName: true, lastName: true },
      },
    },
  });

  return NextResponse.json({ locker }, { status: 201 });
}
