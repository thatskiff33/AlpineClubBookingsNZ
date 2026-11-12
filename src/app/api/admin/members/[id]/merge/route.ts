import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actorIsFullAdmin } from "@/lib/admin-account-guards";
import { executeMemberMerge, MemberMergeError } from "@/lib/member-merge";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { requireRecentAuth } from "@/lib/require-recent-auth";

const paramsSchema = z.object({ id: z.string().min(1) });

const bodySchema = z
  .object({
    loserId: z.string().trim().min(1),
    previewToken: z.string().min(1),
    confirmationText: z.string().min(1),
  })
  .strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  // Full-Admin-only gate (the lib re-checks inside the transaction).
  if (!(await actorIsFullAdmin(prisma, guard.session.user.id))) {
    return NextResponse.json(
      { error: "Only a Full Admin can merge member profiles." },
      { status: 403 },
    );
  }

  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;
  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsedBody = bodySchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsedBody.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await executeMemberMerge({
      masterId: parsedParams.data.id,
      loserId: parsedBody.data.loserId,
      actorMemberId: guard.session.user.id,
      previewToken: parsedBody.data.previewToken,
      confirmationText: parsedBody.data.confirmationText,
      request,
    });
    revalidatePath("/", "layout");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof MemberMergeError) {
      return NextResponse.json(
        { error: err.message, code: err.code, details: err.details },
        { status: err.statusCode },
      );
    }
    throw err;
  }
}
