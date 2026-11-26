/**
 * Lockers (Membership admin area, ALP-720): the locker list and allocations
 * an officer manages on Admin → Lockers.
 */
import {
  bulkCreateLockersSchema,
  createLockerSchema,
  lockerListQuerySchema,
  MAX_BULK_LOCKERS,
  updateLockerSchema,
} from "@/lib/admin-membership-api/lockers";
import {
  LOCKER_BULK_CREATED_CONNECTION_SHAPE,
  LOCKER_CONNECTION_SHAPE,
  LOCKER_DELETED_CONNECTION_SHAPE,
  LOCKER_LIST_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/membership-lockers";
import { routeIdParamsSchema } from "@/lib/route-id-params";

import type { McpAction } from "../catalogue";

export const MEMBERSHIP_LOCKER_MCP_ACTIONS: readonly McpAction[] = [
  {
    id: "list_lockers",
    title: "List lockers",
    summary:
      "The club's lockers, by name, with the member each is allocated to. Give `lodgeId` (from `list_lodges`) for one lodge's lockers.",
    method: "GET",
    path: "/api/admin/lockers",
    query: lockerListQuerySchema,
    kind: "read",
    returns: LOCKER_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_locker",
    title: "Add a locker",
    summary:
      "Adds one locker at a lodge (the club's default lodge when `lodgeId` is left out), optionally allocated to an active member by `allocatedToMemberId`. Names are unique at each lodge.",
    method: "POST",
    path: "/api/admin/lockers",
    body: createLockerSchema,
    kind: "write",
    returns: LOCKER_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_locker",
    title: "Rename or reallocate a locker",
    summary:
      "Renames a locker or changes who it is allocated to. `allocatedToMemberId` is always saved: send the current holder's id to keep them, or null to free the locker; leaving it out frees the locker too.",
    method: "PUT",
    path: "/api/admin/lockers/[id]",
    params: routeIdParamsSchema,
    body: updateLockerSchema,
    kind: "destructive",
    returns: LOCKER_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_locker",
    title: "Delete a locker",
    summary: "Deletes a locker and its allocation. This cannot be undone.",
    method: "DELETE",
    path: "/api/admin/lockers/[id]",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: LOCKER_DELETED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "bulk_create_lockers",
    title: "Add numbered lockers",
    summary: `Adds \`count\` unallocated lockers (at most ${MAX_BULK_LOCKERS}) named "<namePrefix> 1" to "<namePrefix> <count>" ("Locker" when \`namePrefix\` is left out) at one lodge, the default lodge when \`lodgeId\` is left out. Refused if any of the names is already taken there.`,
    method: "POST",
    path: "/api/admin/lockers/bulk",
    body: bulkCreateLockersSchema,
    kind: "write",
    returns: LOCKER_BULK_CREATED_CONNECTION_SHAPE,
    core: false,
  },
];
