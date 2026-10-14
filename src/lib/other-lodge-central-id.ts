import { z } from "zod";
import { OWNED_CENTRAL_LODGE_ID_MAX, type OwnedCentralLodge } from "@/lib/other-lodges";

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

/** A usable central id: non-empty, within the column's bound, no NUL. */
const centralIdSchema = z
  .string()
  .min(1)
  .max(OWNED_CENTRAL_LODGE_ID_MAX)
  .refine((value) => value.trim() === value && !value.includes("\u0000"));

/**
 * The central id a pulled lodge carries, or `null` when it carries none that
 * could key a row (absent, empty, over-long, padded). `null` means "match this
 * lodge by name, as before #64" — never "a lodge with no id".
 */
export function usableCentralId(raw: unknown): string | null {
  const parsed = centralIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The owned-lodge NAMES to store, as this site names them. The central server
 * lists the club's own lodges under ITS names; a lodge this site renamed keeps
 * the local name until the server accepts the rename, so the stored list (which
 * every "may this be changed here?" check reads by local name) maps each owned
 * id back to the local row's name. A name without an id, or an id no local row
 * holds yet, is kept as the server sent it. Order is kept; duplicates dropped.
 */
export function ownedNamesAsLocal(
  ownLodgeNames: ReadonlyArray<string>,
  ownLodges: ReadonlyArray<OwnedCentralLodge> | undefined,
  localNameByCentralId: ReadonlyMap<string, string>,
): string[] {
  const idByName = new Map((ownLodges ?? []).map((l) => [l.name, l.id]));
  const names = ownLodgeNames.map((name) => {
    const id = idByName.get(name);
    return (id !== undefined && localNameByCentralId.get(id)) || name;
  });
  return [...new Set(names)];
}

/** The stored owned list after this site renamed one of its own lodges. */
export function renameInOwnedNames(
  owned: ReadonlyArray<string>,
  from: string,
  to: string,
): string[] {
  return [...new Set(owned.map((name) => (name === from ? to : name)))];
}
