import { Prisma } from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

export const REQUESTED_ROOM_LOCKED_MESSAGE =
  "Your beds have been allocated by the lodge and can no longer be changed here.";

export class RequestedRoomWriteError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RequestedRoomWriteError";
  }
}

export async function writeRequestedRoom(input: {
  bookingId: string;
  actorMemberId: string;
  actorIsAdmin: boolean;
  requestedRoomId: string | null;
  auditActorLabel: "Admin" | "Member";
}) {
  // Resolve only the immutable booking identity before lock acquisition. Room
  // existence, name and lodge membership can all change under the same global
  // lock this writer shares with inventory mutations, so they are authoritative
  // only when re-read inside the transaction below.
  const bookingKey = await prisma.booking.findUnique({
    where: { id: input.bookingId },
    select: { id: true },
  });
  if (!bookingKey) {
    throw new RequestedRoomWriteError("Booking not found", 404);
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await tx.$executeRaw`
      SELECT 1
      FROM "Booking"
      WHERE "id" = ${input.bookingId}
      FOR UPDATE
    `;

    const booking = await tx.booking.findUnique({
      where: { id: input.bookingId },
      select: {
        memberId: true,
        status: true,
        lodgeId: true,
        bedAllocations: {
          where: { approvedAt: { not: null } },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!booking) {
      throw new RequestedRoomWriteError("Booking not found", 404);
    }
    if (!input.actorIsAdmin && bookingOwner(booking).memberId !== input.actorMemberId) {
      throw new RequestedRoomWriteError("Forbidden", 403);
    }
    // Resolve and validate the room only AFTER ownership/authority. A
    // non-owner must not learn whether an arbitrary room id exists or belongs
    // to this booking's lodge. Inventory update/delete takes the same global
    // lock, so this row cannot disappear or be renamed between here, the
    // guarded booking write and the audit entry.
    const roomKey = input.requestedRoomId
      ? await tx.lodgeRoom.findUnique({
          where: { id: input.requestedRoomId },
          // Preserve the established write contract: the public picker offers
          // active rooms, while this service requires only an existing room in
          // the booking's lodge. Do not turn inventory deactivation into a new
          // requested-room validation rule here.
          select: { id: true, name: true, lodgeId: true },
        })
      : null;
    if (input.requestedRoomId && !roomKey) {
      throw new RequestedRoomWriteError("Invalid requested room", 400);
    }
    if (roomKey && roomKey.lodgeId !== booking.lodgeId) {
      throw new RequestedRoomWriteError(
        "Requested room belongs to a different lodge than the booking",
        400,
      );
    }
    if (booking.status === "CANCELLED" || booking.status === "COMPLETED") {
      throw new RequestedRoomWriteError(
        "Cannot update requested room for cancelled or completed bookings",
        400,
      );
    }
    if (booking.bedAllocations.length > 0 && !input.actorIsAdmin) {
      throw new RequestedRoomWriteError(REQUESTED_ROOM_LOCKED_MESSAGE, 409);
    }
    const guarded = await tx.booking.updateMany({
      where: {
        id: input.bookingId,
        status: { notIn: ["CANCELLED", "COMPLETED"] },
        ...(input.actorIsAdmin ? {} : { memberId: input.actorMemberId }),
        ...(input.actorIsAdmin
          ? {}
          : { bedAllocations: { none: { approvedAt: { not: null } } } }),
      },
      data: { requestedRoomId: input.requestedRoomId },
    });
    if (guarded.count !== 1) {
      throw new RequestedRoomWriteError(
        "The booking changed while the room request was saving. Nothing was written.",
        409,
      );
    }

    const updated = await tx.booking.findUniqueOrThrow({
      where: { id: input.bookingId },
      select: {
        id: true,
        requestedRoomId: true,
        requestedRoom: { select: { id: true, name: true, active: true } },
      },
    });
    await createAuditLog(
      {
        action: input.requestedRoomId
          ? "booking.requested_room.updated"
          : "booking.requested_room.cleared",
        memberId: input.actorMemberId,
        targetId: input.bookingId,
        details: input.requestedRoomId
          ? `${input.auditActorLabel} set requested room to "${roomKey?.name ?? input.requestedRoomId}"`
          : `${input.auditActorLabel} cleared requested room`,
        category: "booking",
        outcome: "success",
      },
      tx,
    );
    return updated;
  });
}

export function requestedRoomWriteErrorResponse(error: unknown) {
  if (error instanceof RequestedRoomWriteError) {
    return { error: error.message, status: error.status };
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2034"
  ) {
    return {
      error:
        "The booking changed while the room request was saving. Nothing was written.",
      status: 409,
    };
  }
  return { error: "Requested room update failed", status: 500 };
}
