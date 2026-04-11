import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { ageTierEnum } from "@/lib/age-tier-schema";
import logger from "@/lib/logger";

const createSeasonSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["WINTER", "SUMMER"]),
  startDate: z.string().transform((s) => new Date(s)),
  endDate: z.string().transform((s) => new Date(s)),
  rates: z.array(
    z.object({
      ageTier: ageTierEnum,
      isMember: z.boolean(),
      pricePerNightCents: z.number().int().min(0),
    })
  ),
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  try {
    const seasons = await prisma.season.findMany({
      include: { rates: true },
      orderBy: { startDate: "desc" },
    });
    return NextResponse.json(seasons);
  } catch (err) {
    logger.error({ err }, "Failed to fetch seasons");
    return NextResponse.json({ error: "Failed to fetch seasons" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = createSeasonSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { name, type, startDate, endDate, rates } = parsed.data;

  if (endDate <= startDate) {
    return NextResponse.json({ error: "End date must be after start date" }, { status: 400 });
  }

  const season = await prisma.season.create({
    data: {
      name,
      type,
      startDate,
      endDate,
      rates: {
        create: rates.map((r) => ({
          ageTier: r.ageTier,
          isMember: r.isMember,
          pricePerNightCents: r.pricePerNightCents,
        })),
      },
    },
    include: { rates: true },
  });

  return NextResponse.json(season, { status: 201 });
}
