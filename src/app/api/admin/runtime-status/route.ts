import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRuntimeStatus } from "@/lib/health-check";

export async function GET() {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json(getRuntimeStatus());
}
