import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth, resolveKioskLodgeId } from "@/lib/lodge-auth";
import { getKioskAccessInfo } from "@/lib/kiosk-access";
import { countActiveLodges } from "@/lib/lodges";
import { AmbiguousKioskLodgeError, getStaffLodgeBinding } from "@/lib/lodge-access";
import { parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

/**
 * Name of the lodge this kiosk session operates, for the kiosk header —
 * only when a second active lodge exists (ADR-002 presentation rule), so
 * single-lodge clubs see no change.
 */
async function kioskLodgeName(
  authResult: Parameters<typeof resolveKioskLodgeId>[0],
): Promise<string | null> {
  try {
    if ((await countActiveLodges(prisma)) < 2) return null;
    const lodgeId = await resolveKioskLodgeId(authResult, prisma);
    if (!lodgeId) return null;
    const lodge = await prisma.lodge.findUnique({
      where: { id: lodgeId },
      select: { name: true },
    });
    return lodge?.name ?? null;
  } catch {
    return null;
  }
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * GET /api/lodge/access?date=YYYY-MM-DD
 * Returns the user's kiosk access tier and capabilities for the given date.
 */
export async function GET(req: NextRequest) {
  const dateStr = req.nextUrl.searchParams.get("date");
  if (!dateStr || !dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid or missing date parameter" }, { status: 400 });
  }

  const date = parseDateOnly(dateStr);
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  const authResult = await checkLodgeAuth(dateStr, {
    request: req,
    allowPreview: true,
  });
  if (authResult.error) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status! });
  }

  if ("pinSession" in authResult && authResult.pinSession) {
    return NextResponse.json({
      tier: "hut-leader",
      // #3228 — this device reached the hut-leader tier by PIN on a SHARED
      // account, which is the case the ten-minute idle window and the Lock
      // control govern. A hut leader signed in with their OWN account also
      // reads `tier: "hut-leader"` and must not be swept into either: their
      // session is theirs, on their own device, and dropping them out of it
      // every ten minutes would be a new defect. The flag is what lets the
      // kiosk tell the two apart, and it says nothing the holder of the cookie
      // does not already know from its own tier.
      pinSessionActive: true,
      dateRange: authResult.pinSession.dateRange,
      canManageRoster: true,
      canMarkAttendance: true,
      canCompleteChores: true,
      lodgeName: await kioskLodgeName(authResult),
    });
  }

  if ("member" in authResult && authResult.member) {
    const access = await getKioskAccessInfo(authResult.member, date);

    // When a full admin is previewing a specific kiosk account (issue #23),
    // tell the client so it renders the PREVIEW banner and forces read-only.
    const preview = "preview" in authResult ? authResult.preview : undefined;
    const previewFields = preview
      ? { preview: true as const, previewAccountEmail: preview.targetEmail }
      : {};

    // A kiosk (STAFF) account granted at more than one lodge cannot be scoped
    // to a single property, so every kiosk data route denies it with a 403
    // (M5). Surface that up front so the kiosk shows a fix-the-assignment
    // message instead of rendering enabled UI that then hits clean 403s. Only
    // the STAFF-bound tiers resolve their lodge via getStaffLodgeBinding; hut
    // leaders and staying guests carry their own lodge and are never ambiguous.
    if (access.tier === "lodge" || access.tier === "admin") {
      const binding = await getStaffLodgeBinding(prisma, authResult.member.id);
      if (binding.kind === "ambiguous") {
        // No lodge name or guest/roster data is served here — the same data
        // the M5 denial hides — only a generic fix-the-assignment message.
        return NextResponse.json({
          tier: "none",
          misconfigured: true,
          error: new AmbiguousKioskLodgeError().message,
          dateRange: null,
          canManageRoster: false,
          canMarkAttendance: false,
          canCompleteChores: false,
          lodgeName: null,
          ...previewFields,
        });
      }
    }

    return NextResponse.json({
      ...access,
      lodgeName: await kioskLodgeName(authResult),
      ...previewFields,
    });
  }

  return NextResponse.json({
    tier: "none",
    dateRange: null,
    canManageRoster: false,
    canMarkAttendance: false,
    canCompleteChores: false,
  });
}
