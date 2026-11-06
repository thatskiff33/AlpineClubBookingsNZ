import type { Prisma } from "@prisma/client";
import { asRecord } from "@/lib/xero-json";

/**
 * #4445: the link funnel's `mergeMetadata` write, made atomic.
 *
 * The funnel (`upsertXeroObjectLink`) used to read the stored metadata with no
 * row lock, spread the incoming record over it in JavaScript, and write the
 * result. Two writers of one link both read the old metadata and the later
 * write dropped the earlier one's keys: a refund note's status, a primary
 * invoice's cash-allocation count. The merge is now one `UPDATE` that reads the
 * row it writes, so PostgreSQL applies the second writer over the first one's
 * committed result under READ COMMITTED. It adds no lock: the funnel's upsert
 * of the same row, in the same transaction, already holds that row.
 *
 * The statement keeps the JavaScript spread's meaning exactly, which is why it
 * takes three values rather than one:
 * - `overlay`: over a stored JSON object, the incoming top-level keys win and
 *   nested values are replaced whole. jsonb `||` on two objects does just that.
 * - `removedKeys`: a key the incoming record names with a value JSON cannot
 *   hold (`undefined`) was spread over the stored key and then dropped when the
 *   result was serialised, so the stored key went with it. The canonical-link
 *   heal can send one (`{ status: undefined }` for a row it read with none).
 * - `replacement`: where the stored metadata is not a JSON object (NULL, an
 *   array, a scalar) there was nothing to spread, so the incoming value was
 *   written whole.
 */
export interface XeroObjectLinkMetadataMerge {
  overlay: Prisma.InputJsonObject;
  removedKeys: string[];
  replacement: Prisma.InputJsonValue | null;
}

// One record guard for the Xero modules (#1208): the readers judge these rows through it too.
function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null;
}

/**
 * What one merge write lays over the stored row. `sanitized` is the funnel's
 * `sanitizeForJson(incoming)`, taken by the caller so the redaction rule keeps
 * its one home. Null means the write names no metadata, which leaves the
 * stored value as it was.
 */
export function planXeroObjectLinkMetadataMerge(
  incoming: unknown,
  sanitized: Prisma.InputJsonValue | null | undefined,
): XeroObjectLinkMetadataMerge | null {
  if (incoming === undefined || sanitized === undefined) return null;
  if (isJsonRecord(incoming) && isJsonRecord(sanitized)) {
    const overlay = sanitized as Prisma.InputJsonObject;
    return {
      overlay,
      removedKeys: Object.keys(incoming).filter((key) => !Object.hasOwn(overlay, key)),
      replacement: overlay,
    };
  }
  // Not a record: a stored object is kept, anything else is replaced.
  return { overlay: {}, removedKeys: [], replacement: sanitized };
}

/** One statement, keyed on the row the funnel's upsert just wrote and holds. */
export async function mergeXeroObjectLinkMetadata(
  client: Pick<Prisma.TransactionClient, "$executeRaw">,
  linkId: string,
  merge: XeroObjectLinkMetadataMerge,
): Promise<void> {
  await client.$executeRaw`
    UPDATE "XeroObjectLink"
    SET "metadata" = CASE
      WHEN jsonb_typeof("metadata") = 'object'
        THEN ("metadata" - ${merge.removedKeys}::text[]) || ${JSON.stringify(merge.overlay)}::jsonb
      ELSE ${JSON.stringify(merge.replacement)}::jsonb
    END
    WHERE "id" = ${linkId}`;
}
