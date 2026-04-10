import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { requireActiveSessionUser } from "@/lib/session-guards"
import { validateMinimumStay, formatViolationsDetail } from "@/lib/booking-policies"

export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 })
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { searchParams } = new URL(request.url)
  const checkInStr = searchParams.get("checkIn")
  const checkOutStr = searchParams.get("checkOut")

  if (!checkInStr || !checkOutStr) {
    return NextResponse.json(
      { error: "checkIn and checkOut query parameters are required" },
      { status: 400 }
    )
  }

  const checkIn = new Date(checkInStr)
  const checkOut = new Date(checkOutStr)

  if (isNaN(checkIn.getTime()) || isNaN(checkOut.getTime())) {
    return NextResponse.json(
      { error: "Invalid date format. Use YYYY-MM-DD." },
      { status: 400 }
    )
  }

  if (checkOut <= checkIn) {
    return NextResponse.json(
      { error: "checkOut must be after checkIn" },
      { status: 400 }
    )
  }

  const result = await validateMinimumStay(checkIn, checkOut)

  return NextResponse.json({
    valid: result.valid,
    violations: result.violations,
    message: result.valid ? null : formatViolationsDetail(result.violations),
  })
}
