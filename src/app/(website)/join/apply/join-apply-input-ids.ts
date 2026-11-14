/*
  #4947 — the id of every input on the membership application, defined once.
  The page puts these on its inputs and labels, the phone row on its three
  boxes, and the error summary links to them, so a link can never name an id
  the page does not render. A server key such as `nominator2Email` reaches an
  input only through this map.
*/

/** Inputs that are always on the page, by the field they hold. */
export const JOIN_APPLY_INPUT_IDS = {
  applicantFirstName: "applicantFirstName",
  applicantLastName: "applicantLastName",
  applicantEmail: "applicantEmail",
  applicantDateOfBirth: "applicantDateOfBirth",
  phoneCountryCode: "phoneCountryCode",
  phoneAreaCode: "phoneAreaCode",
  phoneNumber: "phoneNumber",
  nominator1Email: "nominator1Email",
  nominator2Email: "nominator2Email",
} as const;

const FAMILY_FIELD_ID_PREFIXES = {
  firstName: "family-first-name",
  lastName: "family-last-name",
  dateOfBirth: "family-dob",
} as const;

type FamilyField = keyof typeof FAMILY_FIELD_ID_PREFIXES;

/**
 * The id of a household member's input. It is keyed on the member's own id,
 * not their position, so a link made at a submit still finds the same person
 * after another member is removed (or finds nobody, never someone else).
 */
export function familyMemberInputId(memberId: string, field: FamilyField) {
  return `${FAMILY_FIELD_ID_PREFIXES[field]}-${memberId}`;
}

function isSelfField(key: string): key is keyof typeof JOIN_APPLY_INPUT_IDS {
  return Object.hasOwn(JOIN_APPLY_INPUT_IDS, key);
}

function isFamilyField(field: string): field is FamilyField {
  return Object.hasOwn(FAMILY_FIELD_ID_PREFIXES, field);
}

/**
 * The id of the input a field key names, or `null` when no input on the page
 * is certain to be there. `familyMemberIds` is the household as it was when
 * the key was produced, in order: the keys count members by position.
 */
export function joinApplyInputId(
  key: string,
  familyMemberIds: readonly string[],
): string | null {
  if (isSelfField(key)) return JOIN_APPLY_INPUT_IDS[key];
  const [, row, field] = /^familyMembers\.(\d+)\.(\w+)$/.exec(key) ?? [];
  const memberId = row === undefined ? undefined : familyMemberIds[Number(row)];
  return memberId !== undefined && field && isFamilyField(field)
    ? familyMemberInputId(memberId, field)
    : null;
}
