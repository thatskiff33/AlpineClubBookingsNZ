/**
 * Canonical "this member row has been through an approved deletion" predicate
 * (#2620).
 *
 * An approved self-service deletion request anonymises the member in place
 * rather than deleting the row (`POST /api/admin/deletion-requests/[id]`,
 * the "Anonymise the member record" block) — bookings, payments and audit
 * history all reference it. The anonymisation leaves one structural marker on
 * the row and one retained compatibility signal:
 *
 *   - `deletedAt`, stamped by the approving transaction, is authoritative for
 *     every row erased by current code; and
 *   - `email` rewritten to `deleted-xxxxxxxx@deleted.invalid`, on the reserved
 *     `.invalid` TLD (see `DELETED_CONTACT_EMAIL_DOMAIN`), recognises adopter
 *     rows erased before the structural field existed.
 *
 * Neither `cancelledAt` nor `archivedAt` is stamped, so the reactivation
 * refusals that key on those two fields never saw a deleted account: bulk
 * **Reactivate** would happily set `active: true` again and hand the erased
 * person their session — and their retained access roles — back. This module is
 * the single test those paths consult, so a deleted account is recognised
 * identically by the reactivation guards, the login providers and the members
 * list, and none of them can drift into its own copy of the marker test.
 *
 * The legacy address arm is permanent, not a backfill bridge. This repository
 * is the generic product, so an adopter may hold an erased row that predates
 * `deletedAt` and will never be backfilled. Removing the arm would make that
 * row ordinary again and would break INV-LIFE-014's no-session guarantee.
 *
 * This is the one home for both the in-memory decision and its Prisma query
 * projection. Callers must import them from here rather than restating either
 * arm (INV-SSOT-001).
 */
import type { Prisma } from "@prisma/client";
import { DELETED_CONTACT_EMAIL_DOMAIN } from "./placeholder-contact-email";

/**
 * The sentinel written over `Member.passwordHash` when a deletion request is
 * approved. Not a bcrypt hash, so `bcrypt.compare` can never match it.
 */
export const DELETED_ACCOUNT_PASSWORD_HASH = "DELETED_ACCOUNT";

/**
 * Whatever subset of the deletion signals a caller happens to have selected.
 * Both fields are optional so a narrow `select` can still be tested without
 * widening unrelated data.
 */
export type DeletedAccountMarkers = {
  email?: string | null;
  deletedAt?: Date | string | null;
};

/** The 409 a bulk **Reactivate** answers with for a deleted account (#2620). */
export const DELETED_ACCOUNT_BULK_REACTIVATE_MESSAGE =
  "Deleted members cannot be reactivated from bulk update";

/** The 409 the member edit service answers with for a deleted account (#2620). */
export const DELETED_ACCOUNT_EDIT_REACTIVATE_MESSAGE =
  "Deleted members cannot be reactivated from member edit";

/**
 * True when the address is the anonymised one minted by an approved deletion.
 * Case/whitespace-insensitive. Narrower than `isPlaceholderContactEmail`, which
 * also answers true for a walk-in `@no-email.invalid` placeholder — a walk-in
 * contact is a perfectly ordinary member record and must never be mistaken for
 * an erased one.
 */
export function isDeletedAccountEmail(
  email: string | null | undefined,
): boolean {
  if (!email) return false;
  return email
    .trim()
    .toLowerCase()
    .endsWith(`@${DELETED_CONTACT_EMAIL_DOMAIN}`);
}

/**
 * True when the row carries either the structural deletion marker or the
 * permanent adopter-compatibility address. Use this — never a hand-rolled
 * comparison — anywhere an erased account must be refused.
 */
export function isDeletedAccountRecord(
  member: DeletedAccountMarkers | null | undefined,
): boolean {
  if (!member) return false;
  return member.deletedAt != null || isDeletedAccountEmail(member.email);
}

/**
 * The Prisma exclusion counterpart of {@link isDeletedAccountRecord}.
 *
 * Kept beside the runtime predicate so capped database searches can exclude
 * erased rows before applying their limit without restating the two arms at
 * each query site. Returned as `AND` clauses: both signals must be absent.
 */
export function notDeletedAccountWhere(): Prisma.MemberWhereInput[] {
  return [
    { deletedAt: null },
    {
      NOT: {
        email: {
          endsWith: `@${DELETED_CONTACT_EMAIL_DOMAIN}`,
          mode: "insensitive",
        },
      },
    },
  ];
}

/**
 * Read-only SQL projection of {@link isDeletedAccountRecord} for diagnostics
 * statements that cannot call TypeScript per row. Column identifiers are
 * supplied only by trusted source code, never by request data.
 */
export function deletedAccountSql(
  deletedAtColumn: string,
  emailColumn: string,
): string {
  const suffix = `@${DELETED_CONTACT_EMAIL_DOMAIN}`;
  const legacyAddress =
    `(pg_catalog.right(pg_catalog.lower(pg_catalog.btrim(${emailColumn})), ` +
    `${suffix.length}) = '${suffix}')`;
  return `(${deletedAtColumn} IS NOT NULL OR ${legacyAddress})`;
}
