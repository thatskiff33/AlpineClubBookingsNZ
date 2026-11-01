/**
 * #4445: the one test double of the link funnel's metadata-merge statement
 * (`src/lib/xero-object-link-metadata-merge.ts`), for unit tests whose Prisma
 * is a mock or an in-memory fake and so cannot run it.
 *
 * Two things live here so that no test restates them:
 * - `applyLinkMetadataMerge`: what the statement's CASE leaves on a row holding
 *   `stored`. Pinned against `preFix4445MetadataMerge` in
 *   `xero-object-link-metadata-merge.test.ts`; the statement itself is pinned
 *   against the same reference on PostgreSQL in
 *   `xero-object-link-metadata-merge.realdb.test.ts`.
 * - `preFix4445MetadataMerge`: the funnel's merge before #4445, kept as the
 *   meaning both must reproduce.
 */
export const LINK_METADATA_MERGE_SQL_HEAD = 'UPDATE "XeroObjectLink" SET "metadata" = CASE';

export const rawSqlText = (template: TemplateStringsArray) => template.join("?").replace(/\s+/g, " ").trim();

export const isLinkMetadataMergeStatement = (template: TemplateStringsArray) =>
  rawSqlText(template).startsWith(LINK_METADATA_MERGE_SQL_HEAD);

export interface LinkMetadataMergeCall {
  removedKeys: string[];
  overlay: Record<string, unknown>;
  replacement: unknown;
  linkId: string;
}

/** The statement's bound values, in order: removed keys, overlay JSON, replacement JSON, link id. */
export function readLinkMetadataMerge(values: unknown[]): LinkMetadataMergeCall {
  const [removedKeys, overlay, replacement, linkId] = values as [string[], string, string, string];
  return { removedKeys, overlay: JSON.parse(overlay), replacement: JSON.parse(replacement), linkId };
}

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function applyLinkMetadataMerge(stored: unknown, merge: LinkMetadataMergeCall): unknown {
  if (!isJsonRecord(stored)) return merge.replacement;
  const kept = Object.entries(stored).filter(([key]) => !merge.removedKeys.includes(key));
  return { ...Object.fromEntries(kept), ...merge.overlay };
}

/** `sanitize` is the funnel's `sanitizeForJson`, passed in so this file imports no Prisma. */
export function preFix4445MetadataMerge(stored: unknown, incoming: unknown, sanitize: (value: unknown) => unknown): unknown {
  const storedRecord = isJsonRecord(stored) ? stored : null;
  const incomingRecord = isJsonRecord(incoming) ? incoming : null;
  const next = storedRecord || incomingRecord ? { ...(storedRecord ?? {}), ...(incomingRecord ?? {}) } : incoming;
  // Prisma leaves the column alone when the value is undefined.
  return next === undefined ? stored : sanitize(next);
}
