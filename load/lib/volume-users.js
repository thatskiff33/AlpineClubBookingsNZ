/**
 * The volume seeder's member accounts, named once for both sides (#4940,
 * INV-SSOT). `prisma/load-volume-plan.ts` writes `load-00001@<demo domain>`
 * onwards; the k6 scenarios expand LOAD_VOLUME_USERS into the same addresses,
 * so a run spreads its logins and writes over seeded members without a list
 * of emails in the environment. Plain JavaScript because k6 imports it.
 */

export const LOAD_VOLUME_EMAIL_PREFIX = "load-";

/** Local part of the volume member at zero-based `index`. */
export function volumeMemberLocal(index) {
  if (!(Number.isInteger(index) && index >= 0 && index < 99999)) {
    throw new Error("volume member index must be an integer 0..99998, got " + index);
  }
  return LOAD_VOLUME_EMAIL_PREFIX + String(index + 1).padStart(5, "0");
}

/** The first `count` volume member emails at `domain`. */
export function volumeUserPool(count, domain) {
  if (count > 0 && !domain) {
    throw new Error("LOAD_VOLUME_DOMAIN is required when LOAD_VOLUME_USERS > 0");
  }
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(volumeMemberLocal(i) + "@" + domain);
  }
  return out;
}
