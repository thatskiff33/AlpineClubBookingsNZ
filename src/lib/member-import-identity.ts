import { normalizeMemberImportText } from "@/lib/member-csv-import-type-family";

// #4988: identity names compare through the member import's one free-text
// normaliser, so the type name, the family key and "the same person" cannot
// drift apart (`INV-SSOT`).
const normalizeImportIdentityName = normalizeMemberImportText;

/**
 * The one member identity key (#5005, `INV-SSOT`): email plus first and last
 * name, case- and spacing-insensitive. The member import's in-file duplicate
 * check, its route's existing-member match and the paid-booking import's member
 * match all read it, so "the same person" means one thing in all three.
 */
export function memberImportIdentityKey(identity: {
  email: string;
  firstName: string;
  lastName: string;
}) {
  return [
    identity.email.toLowerCase().trim(),
    normalizeImportIdentityName(identity.firstName),
    normalizeImportIdentityName(identity.lastName),
  ].join("\u0000");
}
