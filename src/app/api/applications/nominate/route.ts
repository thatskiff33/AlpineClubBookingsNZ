import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  confirmNomination,
  MembershipApplicationError,
} from "@/lib/nomination";
import { requireActiveSessionUser } from "@/lib/session-guards";
import logger from "@/lib/logger";

const nominateSchema = z.object({
  token: z.string().min(1, "Nomination token is required"),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = nominateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 422 }
    );
  }

  try {
    const result = await confirmNomination(parsed.data.token, session.user.id);

    return NextResponse.json({
      success: true,
      status: result.application.status,
      movedToAdmin: result.movedToAdmin,
      alreadyConfirmed: result.alreadyConfirmed,
    });
  } catch (err) {
    if (err instanceof MembershipApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    logger.error({ err }, "Unexpected error confirming nomination");
    return NextResponse.json(
      { error: "Could not confirm nomination right now" },
      { status: 500 }
    );
  }
}
