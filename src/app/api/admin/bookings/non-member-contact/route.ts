import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  adminNonMemberContactQuerySchema,
  nonMemberContactPostSchema,
} from "@/lib/admin-bookings-schemas/bookings";
import {
  ADMIN_NON_MEMBER_CONTACT_CONNECTION_SHAPE,
  ADMIN_NON_MEMBER_CONTACT_SUGGESTIONS_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/bookings-bookings";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  createNonMemberContact,
  NonMemberContactError,
  reuseNonMemberContact,
  suggestNonMemberContacts,
} from "@/lib/non-member-contact";

/**
 * Book-on-behalf non-member booking owner (issue #1935, E9).
 *
 * Gated on `bookings:edit` (owner-approved scope; #1376 precedent made on-behalf
 * endpoints bookings-scoped, and the record is identical to what the public
 * booking-request approval creates without any admin). The whole endpoint —
 * GET (dedupe suggestions) and POST (create / reuse) — requires the same edit
 * permission, so `bookings:view` and membership-only admins are 403.
 *
 *  - GET  ?email=&name=  → suggest existing non-login NON_MEMBER/SCHOOL contacts
 *                          for the officer to pick ("use existing"). Never
 *                          mutates; never forces reuse.
 *  - POST { firstName, lastName, email?, phone?, noEmail? }
 *                        → create a new non-login owner (server-forced role /
 *                          canLogin:false / emailVerified:false / ageTier:ADULT).
 *  - POST { useExistingContactId } → validate + return a picked existing owner.
 *
 * Also the AI app actions `search_non_member_contacts` (GET) and
 * `create_non_member_contact` (POST, create only) (ALP-719).
 */

const BOOKINGS_EDIT = { area: "bookings", level: "edit" } as const;

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({ permission: BOOKINGS_EDIT });
  if (!guard.ok) return guard.response;

  // Both fields are optional strings, so every request parses; an absent one
  // is passed on as null, as before.
  const query = adminNonMemberContactQuerySchema.safeParse({
    email: request.nextUrl.searchParams.get("email") ?? undefined,
    name: request.nextUrl.searchParams.get("name") ?? undefined,
  });
  const email = (query.success ? query.data.email : undefined) ?? null;
  const name = (query.success ? query.data.name : undefined) ?? null;

  const contacts = await suggestNonMemberContacts({ email, name });
  return connectionJson(request, { contacts }, ADMIN_NON_MEMBER_CONTACT_SUGGESTIONS_CONNECTION_SHAPE);
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin({ permission: BOOKINGS_EDIT });
  if (!guard.ok) return guard.response;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const parsed = nonMemberContactPostSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    if ("useExistingContactId" in parsed.data) {
      const contact = await reuseNonMemberContact(
        parsed.data.useExistingContactId
      );
      return connectionJson(request, { contact, reused: true }, ADMIN_NON_MEMBER_CONTACT_CONNECTION_SHAPE, {
        status: 200,
      });
    }

    const contact = await createNonMemberContact({
      ...parsed.data,
      actorMemberId: guard.session.user.id,
    });
    return connectionJson(request, { contact, reused: false }, ADMIN_NON_MEMBER_CONTACT_CONNECTION_SHAPE, {
      status: 201,
    });
  } catch (err) {
    if (err instanceof NonMemberContactError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    throw err;
  }
}
