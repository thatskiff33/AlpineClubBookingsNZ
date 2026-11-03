/**
 * Book-on-behalf non-member booking owner (issue #1935, E9).
 *
 * Booking officers can create a lightweight, non-login booking owner inline on
 * the Book on Behalf page — the same kind of record the public booking-request
 * approval already mints (booking-request.ts) — and then drive the existing
 * dates/guests/quote/create flow with it as `forMemberId`.
 *
 * Server-forced invariants on every inline-created contact, regardless of
 * payload (the input schema does not even accept these fields, so tampering is
 * structurally impossible):
 *   - role: NON_MEMBER
 *   - canLogin: false          (never authenticates)
 *   - emailVerified: false     (an officer-typed address is UNVERIFIED — unlike
 *                               the public booking-request pipeline, which sets
 *                               true only because it verified the address)
 *   - ageTier: ADULT           (no DOB capture; matches the booking-request
 *                               precedent)
 *
 * Dedupe is suggest-and-pick (mirroring #1255), never silent reuse: several
 * non-login contacts may legitimately share an email (the
 * `Member_email_login_unique` partial index only covers canLogin = true), so the
 * officer must explicitly pick "use existing" vs "create new". Reuse is validated
 * by `assertMappableOwnerContact` in a transaction. A login-capable exact-email
 * match is never reusable and blocks creation with a pointer error.
 *
 * Money stays in integer cents and dates stay NZ date-only elsewhere; this
 * module only creates the owner record.
 */
import { exactContains } from "@/lib/prisma-exact-prefix";
import { randomBytes } from "crypto";
import { hash } from "bcryptjs";
import { PASSWORD_BCRYPT_COST } from "@/lib/password-hashing";
import { AgeTier, Prisma, Role } from "@prisma/client";
import { z } from "zod";
import {
  assertMappableOwnerContact,
  BookingRequestError,
  MAPPABLE_CONTACT_ROLES,
} from "@/lib/booking-request";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import {
  buildPlaceholderContactEmail,
  isPlaceholderContactEmail,
} from "@/lib/placeholder-contact-email";
import { nameField } from "@/lib/zod-helpers";

const SUGGESTION_LIMIT = 8;

export class NonMemberContactError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = "NonMemberContactError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Create input. Deliberately limited to name/email/phone (+ the no-email
 * toggle): role/canLogin/emailVerified/ageTier are NOT accepted so they can
 * only ever take their server-forced values.
 */
export const nonMemberContactCreateSchema = z
  .object({
    firstName: nameField(),
    lastName: nameField(),
    email: z.string().trim().max(320).email().optional(),
    phone: z.string().trim().max(50).optional(),
    // Walk-in without an email (D-R2): store a club-internal placeholder and
    // suppress all outbound email / Xero email-matching for this owner.
    noEmail: z.boolean().optional().default(false),
  })
  .refine((data) => data.noEmail || Boolean(data.email), {
    message: "An email address is required unless 'no email address' is set",
    path: ["email"],
  });

export type NonMemberContactCreateInput = z.infer<
  typeof nonMemberContactCreateSchema
> & { actorMemberId: string };

export interface NonMemberContactResult {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  /** True when `email` is a club-internal placeholder (walk-in with no email). */
  isPlaceholderEmail: boolean;
}

/**
 * Shared suggestion/reuse scope — mirrors the #1255 booking-request contacts
 * route exactly: non-login organisation/booking contacts only, never archived
 * or inactive. A login-capable member can never appear.
 */
const MAPPABLE_CONTACT_SCOPE: Prisma.MemberWhereInput = {
  canLogin: false,
  role: { in: [...MAPPABLE_CONTACT_ROLES] },
  archivedAt: null,
  active: true,
};

export interface NonMemberContactSuggestion {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  isPlaceholderEmail: boolean;
  role: Role;
  phoneNumber: string | null;
  bookingCount: number;
}

/**
 * Suggest existing non-login NON_MEMBER/SCHOOL contacts the officer might reuse
 * as the officer types an email (or name). Case-insensitive email match first,
 * then name — same scope as the #1255 route. Never mutates; never forces reuse.
 */
export async function suggestNonMemberContacts(
  input: { email?: string | null; name?: string | null },
  db: Pick<typeof prisma, "member"> = prisma
): Promise<NonMemberContactSuggestion[]> {
  const email = input.email?.trim() ?? "";
  const name = input.name?.trim() ?? "";

  const or: Prisma.MemberWhereInput[] = [];
  if (email.length >= 2) {
    // Exact email equality is the duplicate case we target; `contains` also
    // surfaces the match as the officer is still typing.
    or.push({ email: { equals: email, mode: "insensitive" } });
    or.push({ email: exactContains(email, "insensitive") });
  }
  if (name.length >= 2) {
    or.push({ firstName: exactContains(name, "insensitive") });
    or.push({ lastName: exactContains(name, "insensitive") });
  }
  if (or.length === 0) return [];

  const contacts = await db.member.findMany({
    where: { AND: [MAPPABLE_CONTACT_SCOPE, { OR: or }] },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      role: true,
      phoneNumber: true,
      _count: { select: { bookings: true } },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: SUGGESTION_LIMIT,
  });

  return contacts.map((contact) => ({
    id: contact.id,
    firstName: contact.firstName,
    lastName: contact.lastName,
    // Never leak the internal placeholder string to the UI as a real address.
    email: isPlaceholderContactEmail(contact.email) ? "" : contact.email,
    isPlaceholderEmail: isPlaceholderContactEmail(contact.email),
    role: contact.role,
    phoneNumber: contact.phoneNumber,
    bookingCount: contact._count.bookings,
  }));
}

/**
 * Validate an officer-picked existing contact for reuse as a booking owner.
 * Runs `assertMappableOwnerContact` inside a transaction so the non-login /
 * role / active / not-archived invariants are checked atomically (the same
 * guard the booking-request approval uses). Returns the reusable owner.
 */
export async function reuseNonMemberContact(
  contactId: string,
  db: typeof prisma = prisma
): Promise<NonMemberContactResult> {
  try {
    return await db.$transaction(async (tx) => {
      const id = await assertMappableOwnerContact(tx, contactId);
      const contact = await tx.member.findUniqueOrThrow({
        where: { id },
        select: { id: true, firstName: true, lastName: true, email: true },
      });
      return {
        id: contact.id,
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: isPlaceholderContactEmail(contact.email) ? "" : contact.email,
        isPlaceholderEmail: isPlaceholderContactEmail(contact.email),
      };
    });
  } catch (err) {
    if (err instanceof BookingRequestError) {
      throw new NonMemberContactError(err.message, err.status, "CONTACT_INVALID");
    }
    throw err;
  }
}

/**
 * Inline-create a non-login NON_MEMBER booking owner. Server-forces role,
 * canLogin, emailVerified and ageTier. A login-capable member with the same
 * email blocks creation (the officer must pick them in the member search
 * instead); several non-login contacts may share an email, so no silent
 * reuse-by-email happens.
 */
export async function createNonMemberContact(
  input: NonMemberContactCreateInput,
  db: typeof prisma = prisma
): Promise<NonMemberContactResult> {
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();

  let resolvedEmail: string;
  let isPlaceholder: boolean;
  if (input.noEmail) {
    resolvedEmail = buildPlaceholderContactEmail();
    isPlaceholder = true;
  } else {
    const typed = (input.email ?? "").trim().toLowerCase();
    if (!typed) {
      throw new NonMemberContactError(
        "An email address is required unless 'no email address' is set",
        422
      );
    }
    // An officer typing a reserved placeholder domain is invalid input, not a
    // walk-in — the no-email toggle is the only way to mint a placeholder.
    if (isPlaceholderContactEmail(typed)) {
      throw new NonMemberContactError("Enter a real email address", 422);
    }
    resolvedEmail = typed;
    isPlaceholder = false;

    // A login-capable exact-email match is a real member — never absorb a
    // booking onto their account. Point the officer at the member search.
    const loginMatch = await db.member.findFirst({
      where: {
        canLogin: true,
        email: { equals: resolvedEmail, mode: "insensitive" },
      },
      select: { id: true },
    });
    if (loginMatch) {
      throw new NonMemberContactError(
        "A member with that email can sign in — pick them in the member search instead of creating a non-member contact.",
        409,
        "LOGIN_MEMBER_EXISTS"
      );
    }
  }

  // Non-login members never authenticate; store a random bcrypt hash so the row
  // satisfies the schema without any usable credential (mirrors booking-request).
  const placeholderPasswordHash = await hash(randomBytes(32).toString("hex"), PASSWORD_BCRYPT_COST);

  const contact = await db.member.create({
    data: {
      email: resolvedEmail,
      passwordHash: placeholderPasswordHash,
      firstName,
      lastName,
      phoneNumber: input.phone?.trim() || null,
      // Server-forced invariants — NOT sourced from the payload.
      role: Role.NON_MEMBER,
      canLogin: false,
      emailVerified: false,
      ageTier: AgeTier.ADULT,
      active: true,
    },
    select: { id: true, firstName: true, lastName: true, email: true },
  });

  logAudit({
    action: "admin.non_member_contact.created",
    memberId: input.actorMemberId,
    actorMemberId: input.actorMemberId,
    subjectMemberId: contact.id,
    entityType: "Member",
    entityId: contact.id,
    category: "booking",
    outcome: "success",
    summary: "Inline non-member booking contact created on Book on Behalf",
    metadata: {
      contactId: contact.id,
      hasEmail: !isPlaceholder,
      noEmailPlaceholder: isPlaceholder,
    },
  });

  return {
    id: contact.id,
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: isPlaceholder ? "" : contact.email,
    isPlaceholderEmail: isPlaceholder,
  };
}
