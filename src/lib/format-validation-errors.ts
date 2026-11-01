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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

/** A zod message list: an array of strings. */
function isMessageList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** zod's `fieldErrors`: every value a message list (or absent). */
function isFieldMessageMap(value: unknown): value is Record<string, string[] | undefined> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => entry === undefined || isMessageList(entry))
  );
}

const FLATTEN_KEYS = new Set(["formErrors", "fieldErrors"]);

/**
 * The field and form-level messages in an API route's validation refusal, or
 * `null` when the body's `details` is not one of the two shapes zod's
 * `flatten()` produces: the full `{ formErrors, fieldErrors }`, or the member
 * routes' bare `fieldErrors` map. Anything else a route puts in `details` (a
 * list of refused rows, a provider payload) is not a field refusal and is not
 * read as one.
 *
 * THE ONE READER of that shape: `formatValidationErrorResponse` below turns it
 * into lines, `readAdminQueryErrorMessage` (`src/lib/admin-query-error.ts`)
 * quotes its first message, and `applyServerValidationErrors`
 * (`src/lib/forms/server-validation-errors.ts`, #4467) puts it back on a
 * form's fields. `validation-details-reader-census.test.ts` fails a module
 * that reads a body's `details` field map itself; the public application
 * form is the one it still names, as debt. Blank messages are dropped, and a
 * field left with none is dropped with them.
 */
export function readValidationDetails(data: unknown): {
  formErrors: string[];
  fieldErrors: Array<[field: string, messages: string[]]>;
} | null {
  if (!isRecord(data) || !isRecord(data.details)) return null;
  const details = data.details;

  const keys = Object.keys(details);
  const isFull =
    keys.length > 0 &&
    keys.every((key) => FLATTEN_KEYS.has(key)) &&
    (details.fieldErrors === undefined || isFieldMessageMap(details.fieldErrors)) &&
    (details.formErrors === undefined || isMessageList(details.formErrors));
  if (!isFull && !isFieldMessageMap(details)) return null;

  const fieldErrors = isFull ? (details.fieldErrors ?? {}) : details;
  return {
    // Top-level, non-field errors exist only in the full flatten() shape.
    formErrors: isFull ? nonEmptyStrings(details.formErrors) : [],
    fieldErrors: Object.entries(fieldErrors as Record<string, unknown>)
      .map(([key, value]): [string, string[]] => [key, nonEmptyStrings(value)])
      .filter(([, messages]) => messages.length > 0),
  };
}

/** One field's messages as one sentence run, as every reader shows them. */
export function joinFieldMessages(messages: readonly string[]): string {
  return messages.join("; ");
}

/** "Date of birth: Invalid date format" — a field's messages under its label. */
export function labelFieldMessages(key: string, messages: readonly string[]): string {
  return `${memberFieldLabel(key)}: ${joinFieldMessages(messages)}`;
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
    ...details.fieldErrors.map(([key, messages]) => labelFieldMessages(key, messages)),
  ];

  return lines.length > 0 ? lines : [fallback];
}
