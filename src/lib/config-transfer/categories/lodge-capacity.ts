import {
  CONFIGURED_LODGE_CAPACITY_RANGE,
  parseConfiguredLodgeCapacity,
} from "@/lib/lodge-effective-capacity";
import {
  loadLodgeCapacityOverride,
  writeImportedLodgeCapacity,
} from "@/lib/lodge-settings";

import type { ReadDb, TxDb } from "../import-types";

// A lodge's capacity in a config bundle (#3407, orchestrator decision on the
// issue). It rides in lodge.json as `capacity`: the lodge's RESOLVED
// LodgeSettings.capacity (its own settings row, or the legacy "default" row
// that still serves it), emitted only when one is set. It is not a Lodge
// column, so lodge-config's buildLodgeData never writes it; apply routes it to
// the settings row through `writeImportedLodgeCapacity`, which is the only
// LodgeSettings writer in a config import (the model is otherwise a
// model-level exclusion).
//
// The field is optional. Absent and null both mean "leave the target's
// capacity alone", in either mode, so an older bundle imports exactly as it did
// before the field existed. A present value must pass the same bounds as Add
// lodge, or the plan errors and apply is blocked.

/** Each lodge's resolved capacity, in the order of `lodgeIds`. */
export function loadLodgeCapacities(
  db: ReadDb,
  lodgeIds: string[],
): Promise<Array<number | null>> {
  return Promise.all(lodgeIds.map((id) => loadLodgeCapacityOverride(db, id)));
}

/** The capacity a lodge.json carries, or undefined when it carries none. */
export function bundleLodgeCapacity(
  descriptor: Record<string, unknown>,
): number | undefined {
  const value = descriptor.capacity;
  return typeof value === "number" ? value : undefined;
}

/**
 * Validate a lodge.json's capacity against the Add lodge bounds. An invalid
 * value is recorded as an error (which blocks apply) and deleted, so no partial
 * write can follow.
 */
export function validateBundleLodgeCapacity(
  descriptor: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (!("capacity" in descriptor) || descriptor.capacity === null) return;
  const value = descriptor.capacity;
  const parsed =
    typeof value === "number"
      ? parseConfiguredLodgeCapacity(String(value))
      : ({ kind: "invalid" } as const);
  if (parsed.kind === "valid") return;
  errors.push(
    `${path}: capacity must be ${CONFIGURED_LODGE_CAPACITY_RANGE}, or left out`,
  );
  delete descriptor.capacity;
}

/**
 * Write the bundle's capacity for one lodge inside the import transaction, when
 * it carries one that differs from the lodge's current figure. `current` is
 * undefined for a lodge this import has just created. Returns whether it wrote.
 */
export async function applyBundleLodgeCapacity(
  tx: TxDb,
  input: {
    descriptor: Record<string, unknown>;
    lodgeId: string;
    current: number | null | undefined;
    actorMemberId: string;
  },
): Promise<boolean> {
  const capacity = bundleLodgeCapacity(input.descriptor);
  if (capacity === undefined || capacity === input.current) return false;
  await writeImportedLodgeCapacity(tx, {
    lodgeId: input.lodgeId,
    capacity,
    updatedByMemberId: input.actorMemberId,
    lodgeCreatedByThisImport: input.current === undefined,
  });
  return true;
}
