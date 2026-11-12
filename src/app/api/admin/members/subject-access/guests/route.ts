/**
 * Guest finder for the subject access report (#4915)
 * GET /api/admin/members/subject-access/guests?name=…
 *
 * Non-member guest rows hold no email address, so a privacy officer answering
 * a guest's request finds the exact row by name and stay instead, and passes
 * its id to the report. Full Admins only; returns at most 20 rows with only
 * the guest names and stay dates.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { isFullAdmin } from "@/lib/access-roles";
import { prisma } from "@/lib/prisma";
import { exactContains } from "@/lib/prisma-exact-prefix";
import { formatDateOnly } from "@/lib/date-only";
import logger from "@/lib/logger";

const MAX_GUESTS = 20;

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({ permission: { area: "membership", level: "view" } });
  if (!guard.ok) return guard.response;
  if (!isFullAdmin(guard.session.user)) {
    return NextResponse.json({ error: "Only a Full Admin can search guests for a subject access report." }, { status: 403 });
  }
  const words = (request.nextUrl.searchParams.get("name") ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4 || words.some((word) => word.length > 60)) {
    return NextResponse.json({ error: "Enter the guest's name." }, { status: 400 });
  }
  try {
    const rows = await prisma.bookingGuest.findMany({
      where: {
        memberId: null,
        AND: words.map((word) => ({
          OR: [
            { firstName: exactContains(word, "insensitive") },
            { lastName: exactContains(word, "insensitive") },
          ],
        })),
      },
      orderBy: [{ stayStart: "desc" }, { id: "asc" }],
      take: MAX_GUESTS,
      select: {
        id: true, firstName: true, lastName: true, stayStart: true, stayEnd: true,
      },
    });
    return NextResponse.json({
      guests: rows.map((row) => ({
        id: row.id,
        name: `${row.firstName} ${row.lastName}`.trim(),
        stayStart: formatDateOnly(row.stayStart),
        stayEnd: formatDateOnly(row.stayEnd),
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    logger.error({ err }, "Subject access guest search failed");
    return NextResponse.json({ error: "Failed to search guests" }, { status: 500 });
  }
}
