import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AgeTier } from "@prisma/client";
import { requireAdmin } from "@/lib/session-guards";
import { isCalendarDate } from "@/lib/club-time";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import {
  getJoiningFeePreviewForInputs,
  getJoiningFeePreviewForMember,
} from "@/lib/joining-fee";

const paramsSchema = z.object({ id: z.string().min(1) });

// Optional raw inputs for a not-yet-created applicant (E10 consumes this). When
// none are supplied, the preview resolves the member named in the route id.
const previewSchema = z
  .object({
    membershipTypeId: z.string().min(1).optional(),
    membershipTypeKey: z.string().min(1).optional(),
    ageTier: z.nativeEnum(AgeTier).nullable().optional(),
    // A REAL DAY, not merely a date-shaped string (#3082 fix round). The bare
    // shape check accepted `1990-13-01` and `1990-02-31`; the first becomes an
    // Invalid Date below and the second silently becomes 3 March. Since #3082
    // `computeAge` refuses both rather than answering `NaN`, and it refuses by
    // throwing — so without this the preview answered 500 where it should answer
    // 400, and before #3082 it answered a wrong ADULT band. This route is the
    // only caller of `getJoiningFeePreviewForInputs`, so validating here closes
    // the path rather than only narrowing it.
    dateOfBirth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(isCalendarDate, "Date of birth must be a real date")
      .optional(),
  })
  .strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Explicit permission gate (E1 pattern — never a bare requireAdmin): the
  // default amount exposes fee configuration, so it is read-gated on finance.
  const guard = await requireAdmin({ permission: { area: "finance", level: "view" } });
  if (!guard.ok) return guard.response;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
  }

  // Body is optional; an empty/absent body means "preview this member".
  let body: unknown = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsedBody = previewSchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsedBody.error.flatten() },
      { status: 400 },
    );
  }

  const { membershipTypeId, membershipTypeKey, ageTier, dateOfBirth } = parsedBody.data;
  const hasRawInputs =
    membershipTypeId != null ||
    membershipTypeKey != null ||
    ageTier !== undefined ||
    dateOfBirth != null;

  // #3123 — ONE read of the club's persisted zone for this preview, and the day
  // the fee schedule's effective window is judged on. It used to be defaulted
  // inside the preview from the ENVIRONMENT's zone, which is a wrong PRICE for a
  // club whose configured zone is behind its container's. React-cached, so
  // whichever branch runs pays for it at most once.
  const asOf = await clubTodayDateOnlyInstant();
  const preview = hasRawInputs
    ? await getJoiningFeePreviewForInputs(
        {
          membershipTypeId: membershipTypeId ?? null,
          membershipTypeKey: membershipTypeKey ?? null,
          ageTier: ageTier ?? null,
          dateOfBirth: dateOfBirth ? new Date(`${dateOfBirth}T00:00:00.000Z`) : null,
        },
        { asOf },
      )
    : await getJoiningFeePreviewForMember(parsedParams.data.id, { asOf });

  return NextResponse.json(preview);
}
