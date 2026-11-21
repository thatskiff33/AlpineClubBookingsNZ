const normalizeImportIdentityName = (value: string) =>
  value.trim().replace(/\s+/g, " ").toLowerCase();

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
