/**
 * The locker routes' request schemas (`/api/admin/lockers/**`), shared with
 * the AI app actions that call them (ALP-720, `INV-SSOT`): the app is
 * described exactly the fields the route enforces.
 */
import { z } from "zod";

/** The most lockers one bulk seed may create. */
export const MAX_BULK_LOCKERS = 100;

const lockerName = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s+/g, " "))
  .pipe(z.string().min(1).max(200));

const allocatedToMemberId = z.string().trim().min(1).max(191).nullable().optional();

/** `GET /api/admin/lockers`: an empty `lodgeId` lists every lodge's lockers. */
export const lockerListQuerySchema = z.object({
  lodgeId: z.string().optional(),
});

/** `POST /api/admin/lockers`. */
export const createLockerSchema = z.object({
  name: lockerName,
  allocatedToMemberId,
  lodgeId: z.string().min(1).optional(),
});

/** `PUT /api/admin/lockers/[id]`: a field left out keeps its value, except the allocation, which clears. */
export const updateLockerSchema = z.object({
  name: lockerName.optional(),
  allocatedToMemberId,
});

/** `POST /api/admin/lockers/bulk`. */
export const bulkCreateLockersSchema = z
  .object({
    count: z.coerce.number().int().min(1).max(MAX_BULK_LOCKERS),
    namePrefix: z.string().trim().min(1).max(80).optional(),
    lodgeId: z.string().min(1).optional(),
  })
  .strict();
