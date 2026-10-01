"use client";

import { useAdminAreaViewAccess } from "@/hooks/use-admin-area-edit-access";

/**
 * The id of the capacity field on the lodge hub (`/admin/lodges/[id]`). The hub
 * renders its input with this id and the not-set-up notice links to it, so the
 * link and its target are one definition (#3407 round-3 review, F2).
 */
export const LODGE_CAPACITY_OVERRIDE_FIELD_ID = "lodge-capacity-override";

/**
 * Where an officer sets a lodge's capacity: the lodge hub's capacity field.
 * With no lodge chosen the calendar shows the default lodge, whose id the
 * caller may not hold, so the lodge list is the honest fallback.
 */
export function lodgeCapacitySettingsHref(lodgeId: string | null): string {
  return lodgeId
    ? `/admin/lodges/${encodeURIComponent(lodgeId)}#${LODGE_CAPACITY_OVERRIDE_FIELD_ID}`
    : "/admin/lodges";
}

/**
 * The link `/admin/book` hands the not-set-up notice, or undefined when the
 * viewer cannot open the lodge area. `/admin/book` is in the bookings area and
 * `/admin/lodges/*` in the lodge area, so a bookings-only officer would
 * otherwise be sent to a page that refuses them. Undefined while the session
 * resolves, so no link flashes in and out.
 */
export function useLodgeCapacitySettingsHref(
  lodgeId: string | null,
): string | undefined {
  return useAdminAreaViewAccess("lodge") === true
    ? lodgeCapacitySettingsHref(lodgeId)
    : undefined;
}
