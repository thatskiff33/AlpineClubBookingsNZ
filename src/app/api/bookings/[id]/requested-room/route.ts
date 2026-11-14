import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasAdminAccess } from "@/lib/access-roles";
import { auth } from "@/lib/auth";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  requestedRoomWriteErrorResponse,
  writeRequestedRoom,
} from "@/lib/requested-room-write";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";

const requestedRoomSchema = z
  .object({ requestedRoomId: z.string().min(1) })
  .strict();

async function requireRoomRequestsEnabled() {
  const modules = await loadEffectiveModuleFlags();
  return modules.bedAllocation
    ? null
    : NextResponse.json(
        { error: "Room requests are not available." },
        { status: 400 },
      );
}

function errorResponse(error: unknown, bookingId: string) {
  const mapped = requestedRoomWriteErrorResponse(error);
  // The write is one lock(1) transaction (INV-LOCK-006): retryable. A write
  // conflict keeps the sentence `requested-room-write.ts` gives it.
  const contended = transactionContendedResponse(
    error,
    "Requested room write contended for the lock(1) budget",
    {
      ...(mapped.status === 409 ? { message: mapped.error } : {}),
      context: { bookingId },
    },
  );
  if (contended) return contended;
  return NextResponse.json({ error: mapped.error }, { status: mapped.status });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;
  const disabled = await requireRoomRequestsEnabled();
  if (disabled) return disabled;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = requestedRoomSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { id } = await params;
  try {
    const updated = await writeRequestedRoom({
      bookingId: id,
      actorMemberId: session.user.id,
      actorIsAdmin: hasAdminAccess(session.user),
      requestedRoomId: parsed.data.requestedRoomId,
      auditActorLabel: "Member",
    });
    return NextResponse.json(updated);
  } catch (error) {
    return errorResponse(error, id);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;
  const disabled = await requireRoomRequestsEnabled();
  if (disabled) return disabled;

  const { id } = await params;
  try {
    const updated = await writeRequestedRoom({
      bookingId: id,
      actorMemberId: session.user.id,
      actorIsAdmin: hasAdminAccess(session.user),
      requestedRoomId: null,
      auditActorLabel: "Member",
    });
    return NextResponse.json(updated);
  } catch (error) {
    return errorResponse(error, id);
  }
}
