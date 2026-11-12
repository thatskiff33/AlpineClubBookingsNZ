import { NextResponse } from "next/server";
import {
  getTwoFactorStatusPayload,
  requireTwoFactorApiSession,
} from "@/lib/two-factor-api";

export async function GET() {
  const guard = await requireTwoFactorApiSession();
  if (!guard.ok) return guard.response;

  return NextResponse.json(
    await getTwoFactorStatusPayload(guard.session, guard.member),
  );
}
