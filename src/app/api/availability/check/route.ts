import { NextRequest, NextResponse } from "next/server";
import { checkCapacity } from "@/lib/capacity";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";

const availabilityCheckQuerySchema = z.object({
  checkIn: z.string().date(),
  checkOut: z.string().date(),
});

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const parsed = availabilityCheckQuerySchema.safeParse({
    checkIn: request.nextUrl.searchParams.get("checkIn"),
    checkOut: request.nextUrl.searchParams.get("checkOut"),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const checkIn = new Date(parsed.data.checkIn);
  const checkOut = new Date(parsed.data.checkOut);

  if (isNaN(checkIn.getTime()) || isNaN(checkOut.getTime())) {
    return NextResponse.json({ error: "Invalid dates" }, { status: 400 });
  }

  if (checkOut <= checkIn) {
    return NextResponse.json({ error: "checkOut must be after checkIn" }, { status: 400 });
  }

  const result = await checkCapacity(checkIn, checkOut, 1);

  return NextResponse.json({
    minAvailable: result.minAvailable,
    nightDetails: result.nightDetails.map((n) => ({
      date: n.date.toISOString().split("T")[0],
      occupiedBeds: n.occupiedBeds,
      availableBeds: n.availableBeds,
    })),
  });
}
