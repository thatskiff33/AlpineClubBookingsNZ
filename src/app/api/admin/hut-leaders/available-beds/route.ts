import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { parseDateOnly } from "@/lib/date-only";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { listCustodianBedOptions } from "@/lib/custodian-assignment";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { hutLeaderBedOptionsQuerySchema } from "@/lib/admin-lodge-schemas/hut-leaders";
import { ADMIN_HUT_LEADER_BED_OPTIONS_CONNECTION_SHAPE } from "@/lib/connection-shapes/lodge-hut-leaders";
import { connectionJson } from "@/lib/mcp-connection-request";

/**
 * GET /api/admin/hut-leaders/available-beds
 *   ?lodgeId=&startDate=&endDate=&assignmentId=
 *
 * Feeds the Hut Leaders form's optional bed picker (#2286). Returns EVERY
 * active bed at the lodge grouped by room, each with whether it can be held for
 * the requested inclusive night range and, when it cannot, exactly which nights
 * block it. Unavailable beds are returned rather than filtered out on purpose:
 * an admin who cannot see why a bed is missing has no way to unblock it.
 *
 * Read-only and lodge-scoped; `assignmentId` (when editing) excludes the
 * assignment's own hold so its current bed stays selectable.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  if (!(await isEffectiveModuleEnabled("bedAllocation"))) {
    // Consistent with the rest of the bed-allocation surface: the module being
    // off means the feature does not exist, not that the caller lacks access.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // The schema is shared with the AI app action `list_hut_leader_bed_options`
  // (ALP-722). Only the dates can fail it, and they answer the same 400.
  const { searchParams } = new URL(req.url);
  const query = hutLeaderBedOptionsQuerySchema.safeParse({
    startDate: searchParams.get("startDate") ?? undefined,
    endDate: searchParams.get("endDate") ?? undefined,
    lodgeId: searchParams.get("lodgeId") ?? undefined,
    assignmentId: searchParams.get("assignmentId") ?? undefined,
  });
  if (!query.success || query.data.startDate > query.data.endDate) {
    return NextResponse.json(
      { error: "startDate and endDate are required (YYYY-MM-DD, start <= end)" },
      { status: 400 },
    );
  }
  const { startDate, endDate, assignmentId } = query.data;
  // #2678 surface 2: A NAMED ASSIGNMENT FIXES THE LODGE, AND THE SERVER OWNS IT.
  //
  // Same rule as `requested-room/options` (#2673), the booking wizard (#2677)
  // and the bed-allocation board (#2678 surface 1), stated in
  // `docs/multi-lodge/lodge-scoping-contract.md`: a read that feeds an editor on
  // a row that already exists derives its lodge from that row, never from a
  // client-supplied `lodgeId`. `HutLeaderAssignment.lodgeId` is NOT NULL, so an
  // assignment always answers the question.
  //
  // Only the EDIT case has an assignment. The create form legitimately passes a
  // chosen lodge — there is no assignment yet — and is unaffected. A
  // contradicting `lodgeId` beside an `assignmentId` is IGNORED rather than
  // rejected, matching the sibling reads: it is not the caller's answer to
  // anything, so refusing it would report a fault in a value the server does not
  // use. The writer's own cross-lodge refusal
  // (`custodian-assignment.ts`, `BED_WRONG_LODGE`) stays as defence in depth.
  //
  // An `assignmentId` that resolves to nothing changes nothing: the caller's own
  // `lodgeId` still applies, and `listCustodianBedOptions` already treats the id
  // as an exclusion hint that simply matches no hold.
  const assignmentLodgeId = assignmentId
    ? (
        await prisma.hutLeaderAssignment.findUnique({
          where: { id: assignmentId },
          select: { lodgeId: true },
        })
      )?.lodgeId
    : undefined;

  /*
    #2887 review (F3): the last hut-leader door that defaulted. Passing
    `undefined` here reaches `getDefaultLodgeId`, so a caller that named no
    lodge was OFFERED the club default's beds. Not reachable today — both call
    sites pass a concrete lodge and the writes re-validate against the locked
    lodge — but it is an offer-vs-write gap, and the argument for closing it is
    the one `POST /api/bookings` already makes: one gate instead of ten, so the
    eleventh screen somebody writes next year fails loudly here rather than
    quietly offering the wrong lodge's beds.
  */
  const requestedLodgeId = assignmentLodgeId ?? query.data.lodgeId;
  if (!requestedLodgeId) {
    return NextResponse.json(
      { error: "A valid lodgeId is required." },
      { status: 400 },
    );
  }
  const lodgeId = await resolveOptionalActiveLodgeId(prisma, requestedLodgeId);
  if (!lodgeId) {
    return NextResponse.json(
      { error: "Lodge not found or not active" },
      { status: 400 },
    );
  }

  const options = await listCustodianBedOptions({
    lodgeId,
    startDate: parseDateOnly(startDate),
    endDate: parseDateOnly(endDate),
    assignmentId,
  });

  // Grouped by room so the picker reads the way the board does.
  const rooms: Array<{
    roomId: string;
    roomName: string;
    beds: typeof options;
  }> = [];
  for (const option of options) {
    let room = rooms.find((entry) => entry.roomId === option.roomId);
    if (!room) {
      room = { roomId: option.roomId, roomName: option.roomName, beds: [] };
      rooms.push(room);
    }
    room.beds.push(option);
  }

  return connectionJson(req, { lodgeId, rooms }, ADMIN_HUT_LEADER_BED_OPTIONS_CONNECTION_SHAPE);
}
