import { centralLodgeIdSchema } from "@/lib/other-lodges";

/**
 * The Alpine Central Server's PERMANENT lodge id on the Other lodges registry
 * (#64). `OtherLodge.centralId` holds it: the download merges by it, so a lodge
 * renamed on the server is renamed here in place, and an owned lodge is
 * uploaded under it (server API 2.3), so a rename made HERE renames the lodge
 * there instead of creating a second one.
 *
 * The same id space as `Lodge.centralLodgeId` and the pull's `ownLodges` (#62),
 * held to the same bound.
 */

/**
 * The central id a pulled lodge carries, or `null` when it carries none that
 * could key a row (absent, empty, over-long, padded). `null` means "match this
 * lodge by name, as before #64" — never "a lodge with no id".
 */
export function usableCentralId(raw: unknown): string | null {
  const parsed = centralLodgeIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
