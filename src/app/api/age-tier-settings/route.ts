import { NextResponse } from "next/server";
import { getAgeTierSettings } from "@/lib/age-tier";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await getAgeTierSettings();
  return NextResponse.json({ settings });
}
