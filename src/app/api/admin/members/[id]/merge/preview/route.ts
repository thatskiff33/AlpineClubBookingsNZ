import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { actorIsFullAdmin } from "@/lib/admin-account-guards";
import { parseJsonRequestBody } from "@/lib/api-json";
import { buildMemberMergePreview, MemberMergeError } from "@/lib/member-merge";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const paramsSchema = z.object({ id: z.string().min(1) });

const bodySchema = z.object({ loserId: z.string().trim().min(1) }).strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  // Full-Admin-only gate, enforced before any preview data is assembled.
  if (!(await actorIsFullAdmin(prisma, guard.session.user.id))) {
    return NextResponse.json(
      { error: "Only a Full Admin can merge member profiles." },
      { status: 403 },
    );
  }

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
  }

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsedBody = bodySchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsedBody.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const preview = await buildMemberMergePreview({
      masterId: parsedParams.data.id,
      loserId: parsedBody.data.loserId,
      actorMemberId: guard.session.user.id,
    });
    return NextResponse.json(preview);
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
