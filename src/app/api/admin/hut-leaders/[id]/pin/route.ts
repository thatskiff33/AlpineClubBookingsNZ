import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { sendHutLeaderAssignmentEmail } from "@/lib/email";
import {
  generateHutLeaderPin,
  hashHutLeaderPin,
} from "@/lib/lodge-pin-session";
import logger from "@/lib/logger";

/**
 * POST /api/admin/hut-leaders/[id]/pin
 * Rotates the hut leader kiosk PIN, emails it, and returns it once.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;
  const assignment = await prisma.hutLeaderAssignment.findUnique({
    where: { id },
    include: {
      member: {
        select: {
          id: true,
          active: true,
          email: true,
          firstName: true,
        },
      },
    },
  });

  if (!assignment || !assignment.member.active) {
    return NextResponse.json(
      { error: "Assignment not found or member inactive" },
      { status: 404 }
    );
  }

  try {
    const pin = generateHutLeaderPin();
    const hutLeaderPin = await hashHutLeaderPin(pin);

    await prisma.hutLeaderAssignment.update({
      where: { id },
      data: { hutLeaderPin },
    });

    let emailSent = true;
    try {
      await sendHutLeaderAssignmentEmail({
        email: assignment.member.email,
        firstName: assignment.member.firstName,
        startDate: assignment.startDate,
        endDate: assignment.endDate,
        pin,
      });
    } catch (err) {
      emailSent = false;
      logger.error(
        { err, assignmentId: assignment.id, memberId: assignment.memberId },
        "Failed to send rotated hut leader PIN email"
      );
    }

    logger.info(
      { assignmentId: assignment.id, memberId: assignment.memberId },
      "Hut leader PIN rotated"
    );

    return NextResponse.json({ pin, emailSent });
  } catch (err) {
    logger.error({ err, assignmentId: id }, "Error rotating hut leader PIN");
    return NextResponse.json(
      { error: "Failed to rotate hut leader PIN" },
      { status: 500 }
    );
  }
}
