// The "which fields changed" lists that admin and self-service writers put in
// an audit row's metadata. Two forms exist on purpose and must stay separate:
// unifying them would change the audit rows already being written.

/**
 * Shallow form: every key of `after` whose value is not strictly equal (`!==`)
 * to the same key of `before`. A `Date` is compared by reference, so a new
 * `Date` instance for the same instant counts as changed.
 */
export function shallowChangedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  return Object.keys(after).filter((key) => before[key] !== after[key]);
}

// Treats a Date as its instant and `undefined` or "" as null, so a cleared
// field and a never-set field compare equal.
function normalizeAuditValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (value === undefined || value === "") {
    return null;
  }
  return value;
}

/**
 * Normalising form: the `fields` that `updateData` carries and whose
 * normalised value differs from `before`'s. Used by the profile writer and the
 * admin member-detail writer.
 */
export function normalizedChangedFields(
  before: Record<string, unknown>,
  updateData: Record<string, unknown>,
  fields: readonly string[],
): string[] {
  return fields.filter((field) => {
    if (!Object.prototype.hasOwnProperty.call(updateData, field)) {
      return false;
    }
    return (
      normalizeAuditValue(before[field]) !==
      normalizeAuditValue(updateData[field])
    );
  });
}

/** Whether any of `fields` appears in a changed-fields list. */
export function hasAnyField(
  changedFields: readonly string[],
  fields: readonly string[],
): boolean {
  return fields.some((field) => changedFields.includes(field));
}
