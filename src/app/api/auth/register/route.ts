import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      error:
        "Self-service registration has been replaced by the membership application process. Please apply at /join/apply.",
    },
    { status: 410 }
  );
}
