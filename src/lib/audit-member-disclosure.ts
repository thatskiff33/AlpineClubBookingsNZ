import type { Prisma } from "@prisma/client";

/**
 * WHAT A MEMBER READS OFF AN AUDIT ROW — declared where the row is written, and
 * denied when nothing is declared (#2695, owner decision of 9 August 2026).
 *
 * WHY THIS EXISTS. `src/lib/audit-query.ts` used to decide what a member saw of
 * an audit row's free text by a SHAPE test: `hasLegacyMetadata ? null :
 * log.details`. A row whose `details` happened to parse as a JSON object showed
 * the member nothing; a row whose `details` was a plain sentence handed them the
 * sentence, whoever wrote it and whatever was in it. Nobody chose either
 * outcome. An administrator rejecting an account-deletion request typed a note
 * under a "do not notify the member" tick and the member read it on their own
 * timeline; a member receiving a credit adjustment read an internal sentence
 * carrying two database ids and the requesting officer's member id. The same
 * mechanism decided both, and it was a property of the JSON parser rather than
 * of anybody's intent.
 *
 * WHAT WAS REJECTED, because this module is easy to mistake for it. #2695
 * sketched two fixes — audience-gate `details` outright, or stop writing free
 * text into `details` and move it into the already-suppressed `metadata` column.
 * The owner refused BOTH, and for one reason: each removes *all* member-visible
 * free text, including the credit reason that is the only explanation a member
 * ever gets for why their balance moved. Today's behaviour shows that text by
 * accident of JSON shape; both proposals would have hidden it by accident of
 * being blunt. Neither lets the club decide.
 *
 * So the decision is per event and explicit, and this module is its vocabulary:
 *
 *   - a writer that declares `{ visibility: "member-facing", text }` states, in
 *     its own words, the one sentence the subject member may read;
 *   - a writer that declares `{ visibility: "internal" }` states that the member
 *     reads no free text from this event at all;
 *   - a writer that declares NOTHING is treated exactly as `internal`, so a new
 *     writer cannot publish an administrator's words by forgetting to think
 *     about it. Default-deny is the whole safety property, which is why the
 *     declaration is OPTIONAL rather than required the way `category` is:
 *     omission is the safe answer here, and omission is not safe for a category.
 *
 * THE DECLARED TEXT IS STORED, NOT RENDERED FROM A TEMPLATE AT READ TIME. An
 * `AuditLog` row is append-only evidence, so what a member was told has to be
 * what the row says, not what today's copy of a renderer would say about it. A
 * central template keyed on `action` would let a later copy-edit silently
 * rewrite history, and would need the writer and the template to agree about a
 * metadata shape that nothing checks.
 *
 * WHERE IT IS STORED, and why not a column of its own. The declared text rides
 * in the `metadata` JSON under ONE reserved key that the write boundary owns
 * (`MEMBER_FACING_AUDIT_TEXT_KEY`). A dedicated `AuditLog` column was the
 * cleaner shape and was not taken: it needs a migration, and this change is
 * otherwise pure application code that applies to the rows ALREADY WRITTEN —
 * a pre-#2695 deletion-rejection note carries no reserved key, so it is denied
 * from the day this ships rather than from the day a backfill runs. Nothing
 * here reclassifies a stored `category`, so `INV-OPS-012` owes no backfill.
 *
 * THE RESERVED KEY IS NOT FORGEABLE BY A CALLER. `src/lib/audit.ts` strips it
 * from whatever metadata a writer supplies and re-attaches it only from a
 * declaration, so `metadata: { memberFacingText: "…" }` at a call site reaches
 * no member. Structural, not policed: there is no lint rule to forget.
 *
 * AND IT IS INDEPENDENT OF PAYLOAD SIZE, which is the hole the old shape test
 * had in a second form. `sanitizeAuditMetadata` reduces a metadata object over
 * its JSON budget to the fields that fit (#2704 — before that it swapped the
 * whole payload for a `{_truncated, preview}` stub, which is what the tests
 * below were written against); if the declared text were merged BEFORE that, a
 * large admin payload would still silently delete what the member reads. The
 * boundary sanitises the caller's metadata first and attaches the declared text
 * afterwards, so no audience decision depends on a length or on whether a
 * payload parses.
 */

/**
 * The reserved `metadata` key holding the sentence the subject member may read.
 *
 * Read at the TOP LEVEL only. A nested occurrence deeper in a caller's payload
 * is inert — it is not stripped and it is not read — because the reader never
 * descends, and stripping at depth would silently rewrite payloads that have
 * nothing to do with this.
 */
export const MEMBER_FACING_AUDIT_TEXT_KEY = "memberFacingText";

/**
 * A writer's declaration, written as an object LITERAL at the call site.
 *
 * The two visibilities live HERE, in the union, and nowhere else. An exported
 * array of the same two strings was written first and deleted: nothing read it,
 * and a second spelling of a two-member vocabulary is the drift `INV-SSOT-001`
 * exists to prevent rather than a convenience.
 *
 * Deliberately not built by a helper function. The audit-writer census reads
 * these from the syntax tree, and a literal `{ visibility: "member-facing" }` is
 * readable there without resolving an import; a helper call would make the
 * census depend on identifier resolution it does not otherwise need. The type
 * carries the part a census cannot: `member-facing` without `text` does not
 * compile.
 */
export type AuditMemberDisclosure =
  | { readonly visibility: "internal" }
  | { readonly visibility: "member-facing"; readonly text: string };

/**
 * Thrown when a declaration reaches the write boundary that cannot be honoured.
 *
 * Failure semantics are the ones `AuditCategoryError` already established at
 * this boundary and are unchanged by being reused: `logAudit` is
 * fire-and-forget and logs it, an awaited writer inside a `$transaction`
 * propagates and rolls back so the audit row and the change it describes still
 * commit together or not at all. Fail-closed in the right direction — no row is
 * written, rather than a row whose declared member text was silently dropped.
 */
export class AuditMemberDisclosureError extends Error {
  readonly action: string;

  constructor(action: string, reason: string) {
    super(
      `Audit write "${action}" declared member-facing text that cannot be ` +
        `stored: ${reason}. See src/lib/audit-member-disclosure.ts (#2695).`
    );
    this.name = "AuditMemberDisclosureError";
    this.action = action;
  }
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/**
 * The sentence the subject member may read, or null when the row declares none.
 *
 * This is the ONLY member-facing free-text path off an audit row. Everything
 * else the member timeline shows is derived from the row's structured columns.
 */
export function readDeclaredMemberText(metadata: unknown): string | null {
  if (!isPlainJsonObject(metadata)) {
    return null;
  }
  const value = metadata[MEMBER_FACING_AUDIT_TEXT_KEY];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Whatever a caller supplied, minus the reserved key.
 *
 * Called on the caller's metadata at the write boundary before anything is
 * attached, so a writer cannot publish to a member by naming the key itself.
 */
export function withoutDeclaredMemberText(metadata: unknown): unknown {
  if (!isPlainJsonObject(metadata)) {
    return metadata;
  }
  if (!(MEMBER_FACING_AUDIT_TEXT_KEY in metadata)) {
    return metadata;
  }
  const rest = { ...metadata };
  delete rest[MEMBER_FACING_AUDIT_TEXT_KEY];
  return rest;
}

/**
 * The stored metadata for a row that declares member-facing text.
 *
 * `sanitized` is the caller's OWN metadata, already through
 * `sanitizeAuditMetadata` — so the JSON-budget stub, if it fired, has fired
 * already and the declared text is attached on top of it rather than into it.
 *
 * `text` must arrive already sanitised by the same function that sanitises the
 * `details` column, so the declared sentence is held to the audit trail's own
 * secret, card and length rules rather than to a second set.
 */
export function withDeclaredMemberText(
  action: string,
  sanitized: Prisma.InputJsonValue | undefined,
  text: string
): Prisma.InputJsonValue {
  if (sanitized === undefined) {
    return { [MEMBER_FACING_AUDIT_TEXT_KEY]: text };
  }
  if (!isPlainJsonObject(sanitized)) {
    // An array or a scalar cannot carry the key, and dropping the declaration
    // silently is the one outcome this module exists to prevent. No production
    // writer passes non-object metadata, so this is defence for the next one.
    throw new AuditMemberDisclosureError(
      action,
      "the site's own metadata is not a JSON object, so the reserved key has " +
        "nowhere to go"
    );
  }
  return {
    ...(sanitized as Prisma.JsonObject),
    [MEMBER_FACING_AUDIT_TEXT_KEY]: text,
  };
}

/**
 * The declared text a boundary should store, or null for "the member reads
 * nothing" — which is both `{ visibility: "internal" }` and no declaration.
 *
 * `sanitize` is passed in rather than imported so this module stays free of
 * `server-only`: `audit-query.ts` reaches it from a client component's import
 * graph, and `audit.ts` owns the sanitiser.
 */
export function resolveDeclaredMemberText(
  action: string,
  disclosure: AuditMemberDisclosure | undefined,
  sanitize: (value: string) => string | null
): string | null {
  if (!disclosure || disclosure.visibility === "internal") {
    return null;
  }
  const sanitized = sanitize(disclosure.text);
  if (!sanitized || sanitized.trim().length === 0) {
    throw new AuditMemberDisclosureError(
      action,
      "the declared text is empty once sanitised, which would leave the " +
        "member with a declaration and no explanation"
    );
  }
  return sanitized;
}
