import { NextRequest, NextResponse } from "next/server";
import {
  getBedAllocationDashboard,
} from "@/lib/bed-allocation-board";
import {
  parseBedAllocationDateRange,
} from "@/lib/bed-allocation-date-range";
import {
  bedAllocationErrorResponse,
  requireBedAllocationRead,
} from "@/lib/admin-bed-allocation-routes";
import {
  BOARD_LODGE_MISMATCH_CODE,
  BOARD_LODGE_MISMATCH_MESSAGE,
  boardLodgeScopeMismatch,
} from "@/lib/bed-allocation-board-scope";
import { prisma } from "@/lib/prisma";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { clubTime } from "@/lib/club-time/server";

// requireAdmin() is enforced by requireBedAllocationRead().
export async function GET(request: NextRequest) {
  const guard = await requireBedAllocationRead();
  if (!guard.ok) return guard.response;

  try {
    // The club's own day, for the board's default window when the caller names
    // no `from` (#3123, `INV-CONFIG-002`). Resolved here, once, and passed in:
    // the parse is synchronous and must not read the setting itself — see its
    // docblock and `INV-LOCK-004`.
    const range = parseBedAllocationDateRange(
      {
        from: request.nextUrl.searchParams.get("from"),
        to: request.nextUrl.searchParams.get("to"),
      },
      (await clubTime()).today(),
    );
    const bookingId = request.nextUrl.searchParams.get("bookingId");
    // #2678: A NAMED BOOKING FIXES THE LODGE, AND THE SERVER OWNS IT.
    //
    // `docs/multi-lodge/lodge-scoping-contract.md` already states the rule this
    // now follows: "Editing a booking that already exists is scoped by that
    // booking, not by the editor's own eligibility ... a read that feeds an
    // editor on that booking derives its lodge from `Booking.lodgeId`
    // server-side ... never from a client-supplied `lodgeId`". This was the
    // last booking-scoped read still taking the lodge from the caller, after
    // #2673 (the requested-room picker) and #2677 (the booking wizard).
    //
    // It is not merely a hand-crafted-request concern. `admin-booking-tools-
    // card.tsx` deep-links this board with `bookingId` and NO `lodgeId`, so an
    // admin two clicks from a booking page landed on a CLUB-WIDE board focused
    // on that booking, whose bed pickers offered every lodge's beds for its
    // guests — the exact #2664 symptom, with the write then refused at
    // `bed-allocation-placement.ts` ("Bed belongs to a different lodge than the
    // booking"). Deriving the scope here makes the offer match the write.
    //
    // #2701 CHANGED WHAT HAPPENS TO A CONTRADICTORY `lodgeId`. It used to be
    // ignored here, matching `requested-room/options`. It is now REFUSED with a
    // 409, because this surface is different from the others in one way that
    // matters: the board renders the focused booking and a lodge selector side
    // by side, so quietly serving lodge A's board for a lodge-B booking under a
    // selector reading "Lodge A" is an internally contradictory screen rather
    // than a redundant parameter. The refusal is safe precisely because the
    // client can no longer produce the pair — the board sends the booking's own
    // lodge, or sends no lodge and adopts the one this route derived — so it
    // fires only on a hand-made URL or a bug. An unresolvable `bookingId`
    // changes nothing: the caller's own scope still applies, and the focus
    // lookup inside the dashboard already returns nothing for it.
    //
    // Status is deliberately NOT filtered here. The lodge is a fact about the
    // row whatever its status, and a cancelled booking's board still has to be
    // readable; `focusedBooking` keeps its own stricter allocatable/non-deleted
    // filter for the window it snaps onto.
    const bookingLodgeId = bookingId
      ? (
          await prisma.booking.findUnique({
            where: { id: bookingId },
            select: { lodgeId: true },
          })
        )?.lodgeId
      : undefined;

    // Scope the board to one lodge (ADR-003); omitted = club-wide, which is a
    // deliberate operator view since #2701 and preserves single-lodge
    // behaviour.
    const requestedLodgeId =
      request.nextUrl.searchParams.get("lodgeId") ?? undefined;
    // The board-level backstop (#2701), mirroring the writer's own
    // LODGE_MISMATCH refusal in `bed-allocation-move.ts`. Checked before the
    // active-lodge validation below so a contradiction reads as a
    // contradiction, not as "lodge not found".
    if (boardLodgeScopeMismatch(bookingLodgeId, requestedLodgeId)) {
      return NextResponse.json(
        {
          error: BOARD_LODGE_MISMATCH_MESSAGE,
          code: BOARD_LODGE_MISMATCH_CODE,
        },
        { status: 409 },
      );
    }
    // Validate an explicit lodge scope the way the write paths do (400 on
    // unknown/inactive); omitted stays club-wide. Only the scope actually used
    // is validated — a booking that fixes the lodge has already answered the
    // question, and the contradiction case is refused above.
    if (
      !bookingLodgeId &&
      requestedLodgeId &&
      !(await resolveOptionalActiveLodgeId(prisma, requestedLodgeId))
    ) {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 },
      );
    }
    const scopedLodgeId = bookingLodgeId ?? requestedLodgeId ?? null;
    return NextResponse.json({
      ...(await getBedAllocationDashboard({
        range,
        lodgeId: scopedLodgeId ?? undefined,
        bookingId,
      })),
      // #2701: echo the lodge the board was ACTUALLY scoped to, so the client's
      // selector can adopt it instead of guessing. This is the whole fix for a
      // deep link that names a booking and no lodge: the server knows the
      // booking's lodge, the client does not, and without being told the
      // selector would default to `lodges[0]`. Null means a deliberate
      // club-wide read. Added here rather than inside
      // `getBedAllocationDashboard` because the derivation is this route's
      // knowledge, and because #2688 is about to split that module.
      scopedLodgeId,
    });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
