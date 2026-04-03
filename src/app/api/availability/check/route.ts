import { NextRequest, NextResponse } from "next/server";
import { checkCapacity } from "@/lib/capacity";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const checkInStr = searchParams.get("checkIn");
  const checkOutStr = searchParams.get("checkOut");

  if (!checkInStr || !checkOutStr) {
    return NextResponse.json({ error: "checkIn and checkOut are required" }, { status: 400 });
  }

  const checkIn = new Date(checkInStr);
  const checkOut = new Date(checkOutStr);

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
