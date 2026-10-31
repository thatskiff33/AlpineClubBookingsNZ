// Turns a server 422 validation response into human-readable, per-field lines
// so admins see *which* field failed and *why* instead of a bare
// "Validation failed". Handles both shapes the API emits:
//   - the raw `flatten().fieldErrors` map (member create/update routes):
//       { email: ["Invalid email address"], dateOfBirth: ["Invalid date format"] }
//   - the full `flatten()` object: { formErrors: [...], fieldErrors: { ... } }

/**
 * Friendly labels for the member create/update field keys. Anything not listed
 * falls back to {@link humanizeFieldKey}, so new fields still render sensibly.
 */
const MEMBER_FIELD_LABELS: Record<string, string> = {
  email: "Email",
  title: "Title",
  firstName: "First name",
  lastName: "Last name",
  gender: "Gender",
  occupation: "Occupation",
  phoneCountryCode: "Phone country code",
  phoneAreaCode: "Phone area code",
  phoneNumber: "Phone number",
  dateOfBirth: "Date of birth",
  role: "Role",
  financeAccessLevel: "Finance access",
  accessRoles: "Access roles",
  ageTier: "Age tier",
  active: "Active",
  sendInvite: "Send invite",
  canLogin: "Can login",
  forcePasswordChange: "Force password change",
  requiresInduction: "Requires induction",
  parentMemberId: "Parent member",
  inheritParentEmail: "Inherit parent email",
  inheritEmailFromId: "Inherit email from",
  familyGroupIds: "Family groups",
  joinedDate: "Joined date",
  lifeMemberDate: "Life member date",
  comments: "Comments",
  streetAddressLine1: "Street address line 1",
  streetAddressLine2: "Street address line 2",
  streetCity: "Street city",
  streetRegion: "Street region",
  streetPostalCode: "Street postal code",
  streetCountry: "Street country",
  postalAddressLine1: "Postal address line 1",
  postalAddressLine2: "Postal address line 2",
  postalCity: "Postal city",
  postalRegion: "Postal region",
  postalPostalCode: "Postal postal code",
  postalCountry: "Postal country",
  postalSameAsPhysical: "Postal same as physical",
};

/**
 * Fallback label for a field key with no explicit mapping: splits camelCase and
 * letter/number boundaries, replaces separators, then Title-cases the first
 * word. e.g. "streetAddressLine1" -> "Street address line 1".
 */
export function humanizeFieldKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/[_.]+/g, " ")
    .trim();
  if (!words) return key;
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** Resolve the display label for a member field key. */
export function memberFieldLabel(key: string): string {
  return MEMBER_FIELD_LABELS[key] ?? humanizeFieldKey(key);
}

interface FlattenShape {
  formErrors?: unknown;
  fieldErrors?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

/**
 * The field and form-level messages in an API route's validation refusal, or
 * `null` when the body carries no `details` object. The one reader of that
 * shape: `formatValidationErrorResponse` below turns it into lines, and
 * `applyServerValidationErrors` (`src/lib/forms/server-validation-errors.ts`,
 * #4467) puts it back on a form's fields. Both shapes the routes send are read
 * (see the top of this file); blank and non-string messages are dropped, and a
 * field left with none is dropped with them.
 */
export function readValidationDetails(data: unknown): {
  formErrors: string[];
  fieldErrors: Array<[field: string, messages: string[]]>;
} | null {
  if (!isRecord(data) || !isRecord(data.details)) return null;

  const details = data.details;
  // Full flatten() shape carries a nested `fieldErrors` object; the member
  // routes send that nested object directly as `details`.
  const hasFlattenShape =
    "fieldErrors" in details && isRecord((details as FlattenShape).fieldErrors);
  const fieldErrors = hasFlattenShape
    ? ((details as FlattenShape).fieldErrors as Record<string, unknown>)
    : details;

  return {
    // Top-level, non-field errors exist only in the full flatten() shape.
    formErrors: hasFlattenShape
      ? nonEmptyStrings((details as FlattenShape).formErrors)
      : [],
    fieldErrors: Object.entries(fieldErrors)
      .map(([key, value]): [string, string[]] => [key, nonEmptyStrings(value)])
      .filter(([, messages]) => messages.length > 0),
  };
}

/**
 * Flatten a 422 validation response into one legible line per field
 * (e.g. "Date of birth: Invalid date format"). Callers can render the array as
 * a list. Falls back to `data.error`, then `options.defaultMessage`, then
 * "Save failed" when no field-level detail is present.
 */
export function formatValidationErrorResponse(
  data: unknown,
  options?: { defaultMessage?: string },
): string[] {
  const defaultMessage = options?.defaultMessage ?? "Save failed";
  const fallback =
    isRecord(data) && typeof data.error === "string" && data.error.trim().length > 0
      ? data.error
      : defaultMessage;

  const details = readValidationDetails(data);
  if (!details) return [fallback];

  const lines = [
    // Top-level, non-field errors surface without a label.
    ...details.formErrors,
    ...details.fieldErrors.map(
      ([key, messages]) => `${memberFieldLabel(key)}: ${messages.join("; ")}`,
    ),
  ];

  return lines.length > 0 ? lines : [fallback];
}
