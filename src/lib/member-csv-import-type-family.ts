/**
 * The member CSV import's Membership Type and Family Key columns (#4988): how
 * a value compares and when a row is refused. The browser preview and the
 * server import both call these, so they cannot disagree.
 *
 * Browser-safe: no Prisma, no server imports.
 */
import { ADMIN_FAMILY_GROUP_MAX_MEMBERS } from "@/lib/admin-family-group-create";

export const MEMBER_IMPORT_MEMBERSHIP_TYPE_MAX_LENGTH = 200;
export const MEMBER_IMPORT_FAMILY_KEY_MAX_LENGTH = 100;

/** How a membership type name compares: case, spacing and ends ignored. */
export function normalizeMemberImportMembershipTypeName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export type MemberImportMembershipTypeMatch<T extends { name: string }> =
  | { ok: true; type: T }
  | { ok: false; error: string };

/**
 * Match one imported Membership Type value against the club's ACTIVE types by
 * name (#4988). The browser preview and the server both call this; the server
 * passes the types it read itself, so its answer is the authoritative one.
 */
export function matchMemberImportMembershipType<T extends { name: string }>(
  value: string,
  activeTypes: readonly T[],
): MemberImportMembershipTypeMatch<T> {
  const wanted = normalizeMemberImportMembershipTypeName(value);
  const matches = activeTypes.filter(
    (type) => normalizeMemberImportMembershipTypeName(type.name) === wanted,
  );
  const [only] = matches;
  if (only && matches.length === 1) return { ok: true, type: only };
  if (matches.length > 1) {
    return {
      ok: false,
      error: `matches ${matches.length} active membership types named "${value}"; rename one in Membership Types first`,
    };
  }
  return {
    ok: false,
    error: `"${value}" is not the name of an active membership type`,
  };
}

/** How a family key compares: case, spacing and ends ignored. */
export function normalizeMemberImportFamilyKey(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The family-key refusal shared by the preview and the server (#4988): a key
 * shared by more rows than one family group may hold blocks every one of
 * those rows. Returns the message for each offending key.
 */
export function findOversizedMemberImportFamilyKeys(
  familyKeys: readonly (string | undefined)[],
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const value of familyKeys) {
    if (!value) continue;
    const key = normalizeMemberImportFamilyKey(value);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const oversized = new Map<string, string>();
  for (const [key, count] of counts) {
    if (count > ADMIN_FAMILY_GROUP_MAX_MEMBERS) {
      oversized.set(
        key,
        `is shared by ${count} rows; a family group holds at most ${ADMIN_FAMILY_GROUP_MAX_MEMBERS} members`,
      );
    }
  }
  return oversized;
}

/** ` (column X)` naming the source column a value came from, or empty. */
type ColumnContext = (key: "membershipType" | "familyKey") => string;

/**
 * One preview row's own refusals for the two columns: too long, or (when the
 * dialog read the club's active types) a type name that matches none.
 */
export function memberImportTypeFamilyErrors({
  membershipType,
  familyKey,
  activeMembershipTypeNames,
  columnContext,
}: {
  membershipType: string;
  familyKey: string;
  activeMembershipTypeNames: readonly string[] | undefined;
  columnContext: ColumnContext;
}): string[] {
  const errors: string[] = [];
  if (membershipType.length > MEMBER_IMPORT_MEMBERSHIP_TYPE_MAX_LENGTH) {
    errors.push(
      `Membership Type${columnContext("membershipType")} must be ${MEMBER_IMPORT_MEMBERSHIP_TYPE_MAX_LENGTH} characters or fewer`,
    );
  } else if (membershipType && activeMembershipTypeNames) {
    const match = matchMemberImportMembershipType(
      membershipType,
      activeMembershipTypeNames.map((name) => ({ name })),
    );
    if (!match.ok) {
      errors.push(`Membership Type${columnContext("membershipType")} ${match.error}`);
    }
  }
  if (familyKey.length > MEMBER_IMPORT_FAMILY_KEY_MAX_LENGTH) {
    errors.push(
      `Family Key${columnContext("familyKey")} must be ${MEMBER_IMPORT_FAMILY_KEY_MAX_LENGTH} characters or fewer`,
    );
  }
  return errors;
}

/** Block every preview row whose Family Key is shared by too many rows of the file. */
export function appendOversizedFamilyKeyErrors(
  rows: ReadonlyArray<{ values: { familyKey?: string }; errors: string[] }>,
  columnContext: ColumnContext,
) {
  const oversized = findOversizedMemberImportFamilyKeys(
    rows.map((row) => row.values.familyKey),
  );
  for (const row of rows) {
    const familyKey = row.values.familyKey;
    const message =
      familyKey && oversized.get(normalizeMemberImportFamilyKey(familyKey));
    if (message) {
      row.errors.push(`Family Key${columnContext("familyKey")} "${familyKey}" ${message}`);
    }
  }
}
