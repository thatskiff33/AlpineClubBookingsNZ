import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { requireActiveSessionUser } from "@/lib/session-guards"
import { validateMinimumStay, formatViolationsDetail } from "@/lib/booking-policies"
import { z } from "zod"

const bookingPolicyCheckQuerySchema = z.object({
  checkIn: z.string().date(),
  checkOut: z.string().date(),
})

export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 })
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const parsed = bookingPolicyCheckQuerySchema.safeParse({
    checkIn: request.nextUrl.searchParams.get("checkIn"),
    checkOut: request.nextUrl.searchParams.get("checkOut"),
  })

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const checkIn = new Date(parsed.data.checkIn)
  const checkOut = new Date(parsed.data.checkOut)

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
