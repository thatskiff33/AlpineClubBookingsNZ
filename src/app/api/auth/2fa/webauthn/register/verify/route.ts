import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getAuditRequestContext } from "@/lib/audit";
import { verifyPasskeyRegistration } from "@/lib/webauthn";

import { guardPasskeyRequest, passkeyJsonError, registrationAllowed } from "../../guard";

const bodySchema = z
  .object({
    name: z.string().max(80).optional(),
    response: z.unknown(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const guard = await guardPasskeyRequest(request);
  if (!guard.ok) return guard.response;
  const refused = registrationAllowed(guard);
  if (refused) return refused;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return passkeyJsonError(400, "Invalid JSON payload");
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = await verifyPasskeyRegistration({
    memberId: guard.member.id,
    response: parsed.data.response,
    name: parsed.data.name,
    actor: { kind: "member", memberId: guard.member.id },
    request: getAuditRequestContext(request),
  });
  if (!result.ok) return passkeyJsonError(result.status, result.error);
  return NextResponse.json({ ok: true });
}
