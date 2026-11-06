import type { ConfigTransferCategory } from "./manifest";

// The entity registry: the contract shared by the export serialisers and the
// import planner. Each in-scope entity declares its category, identity tier,
// on-disk format, natural key, and an explicit field allowlist. Concrete
// descriptors are registered per category in their own modules (site-content,
// club-settings, lodge-config, committee, induction, xero-config) so each is
// defined next to the code that reads/writes it. See
// docs/config-transfer/decisions/ADR-001-interchange-format-and-identity-strategy.md.

/**
 * key-strong: a DB-enforced unique constraint backs the natural key → the
 * importer may auto-upsert silently.
 * key-weak: no enforced unique → "document" matching by candidate fields, with
 * anything ambiguous deferred to the interactive picker (ADR-001/002).
 */
export type EntityTier = "key-strong" | "key-weak";

export type EntityFormat = "csv" | "json";

export interface EntityDescriptor {
  /** Logical entity id, unique across the registry, e.g. "page-content". */
  entity: string;
  category: ConfigTransferCategory;
  tier: EntityTier;
  format: EntityFormat;
  /** File path within the zip, e.g. "site-content/pages.csv". */
  file: string;
  /** Business identifier fields used for matching; [] for a singleton. */
  naturalKey: string[];
  /** True = exactly one row (e.g. id="default" settings), serialised as JSON. */
  singleton: boolean;
  /**
   * Allowlisted fields to (de)serialise. Export emits ONLY these; import reads
   * ONLY these. This is the security spine — nothing outside the allowlist can
   * ever enter or leave via a bundle. Must not intersect FORBIDDEN_FIELD_PATTERNS.
   */
  fields: string[];
  /**
   * Fields exported only when the admin explicitly opts in (e.g. door codes,
   * physical-access info). Omitted from the default bundle. Must be a subset of
   * `fields` and are allowed to match SENSITIVE_OPT_IN_PATTERNS.
   */
  optInFields?: string[];
}

/**
 * Fields that must NEVER appear in a bundle under any option: secrets, auth
 * material, and member coupling. A test asserts every descriptor's allowlist is
 * disjoint from these, and serialisers must never emit them.
 */
export const FORBIDDEN_FIELD_PATTERNS: RegExp[] = [
  // Any "password" field is credential material and must never travel — EXCEPT
  // the password-POLICY length bound (`minPasswordLength` / `maxPasswordLength`),
  // which is a portable club rule carrying an integer, not a secret (#2200). The
  // exemption is narrow — only "password" immediately followed by the whole word
  // "length" (word-boundary anchored), so `passwordHash` / bare `password` /
  // `forcePasswordChange` stay forbidden here, the hash is additionally blocked
  // by the dedicated /passwordhash/i pattern below, and any secret-suffixed name
  // (e.g. "...secret", "...token") is still caught by its own pattern.
  // #4610 adds the one boolean policy switch `breachedPasswordCheck` ("password"
  // followed by the whole word "check"), a portable on/off club rule.
  /password(?!length\b|check\b)/i,
  /secret/i,
  /token/i,
  /(^|[^a-z])api[_-]?key/i,
  /passwordhash/i,
  // Encrypted-integration-credential material (#2079). The IntegrationCredential
  // entity is deliberately NOT registered for export, so it can never leave via
  // a bundle; these patterns are defence-in-depth so no future descriptor can
  // ever allowlist a ciphertext/auth-tag field. (`iv` is too generic to pattern
  // safely — the entity-exclusion is what protects it, asserted by a test.)
  /ciphertext/i,
  /auth.?tag/i,
  // 2FA/OTP *secrets* — but not the plain `twoFactor` module toggle (config).
  /two.?factor.*(secret|code|hash|token)/i,
  /totp/i,
  /recoverycode/i,
  // Member identity coupling (members are out of scope entirely).
  /^memberid$/i,
  /memberid$/i, // updatedByMemberId, uploadedByMemberId, allocatedToMemberId, …
];

/**
 * Fields allowed only behind an explicit opt-in (physical-access / operational
 * sensitivity). Permitted in `optInFields` but never in the default export.
 */
export const SENSITIVE_OPT_IN_PATTERNS: RegExp[] = [/doorcode/i];

export function isForbiddenField(field: string): boolean {
  return FORBIDDEN_FIELD_PATTERNS.some((pattern) => pattern.test(field));
}

export function isSensitiveOptInField(field: string): boolean {
  return SENSITIVE_OPT_IN_PATTERNS.some((pattern) => pattern.test(field));
}

/**
 * Validate a descriptor's field declarations. Throws on any violation so a
 * mis-declared descriptor fails fast (in tests and at module load). Rules:
 * - no allowlisted field may match a forbidden pattern;
 * - optInFields must be a subset of fields;
 * - a non-singleton must declare a non-empty natural key;
 * - a sensitive-opt-in field must be declared in optInFields (not plain fields).
 */
export function assertDescriptorValid(descriptor: EntityDescriptor): void {
  for (const field of descriptor.fields) {
    if (isForbiddenField(field)) {
      throw new Error(
        `Descriptor "${descriptor.entity}" allowlists a forbidden field: ${field}`,
      );
    }
  }
  for (const field of descriptor.optInFields ?? []) {
    if (!descriptor.fields.includes(field)) {
      throw new Error(
        `Descriptor "${descriptor.entity}" optInField not in fields: ${field}`,
      );
    }
    if (isForbiddenField(field)) {
      throw new Error(
        `Descriptor "${descriptor.entity}" optInField is forbidden: ${field}`,
      );
    }
  }
  for (const field of descriptor.fields) {
    if (
      isSensitiveOptInField(field) &&
      !(descriptor.optInFields ?? []).includes(field)
    ) {
      throw new Error(
        `Descriptor "${descriptor.entity}" field "${field}" is sensitive and ` +
          `must be declared in optInFields`,
      );
    }
  }
  if (!descriptor.singleton && descriptor.naturalKey.length === 0) {
    throw new Error(
      `Descriptor "${descriptor.entity}" is not a singleton but has no natural key`,
    );
  }
}

const registry = new Map<string, EntityDescriptor>();

/** Register a descriptor (validated). Called by each category module at load. */
export function registerEntity(descriptor: EntityDescriptor): EntityDescriptor {
  assertDescriptorValid(descriptor);
  if (registry.has(descriptor.entity)) {
    throw new Error(`Duplicate entity descriptor: ${descriptor.entity}`);
  }
  registry.set(descriptor.entity, descriptor);
  return descriptor;
}

export function getRegisteredEntities(): EntityDescriptor[] {
  return [...registry.values()];
}
