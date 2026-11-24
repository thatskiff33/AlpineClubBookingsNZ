/**
 * Lodge setup: the club's lodges, each lodge's central-server link and member
 * roster name detail, the lodge settings, and the Other lodges registry.
 * Part of the Lodge Operations officer actions (ALP-722): spread into
 * `MCP_ACTIONS`.
 *
 * Kinds: every change here is `destructive`. A lodge, its capacity, its
 * central-server link, how much of a name its roster shows, and this club's
 * entry in the shared Other lodges registry (uploaded to the Alpine Central
 * Server) are club-wide configuration, which an officer's app may change only
 * after asking the officer first (owner decision, #5305 comment 7093303964,
 * item 2).
 *
 * The door code is never offered: the lodge create and update actions take
 * the route's schema without it, and their answers leave it out. The lodge
 * instructions route that holds it is website-only (`exclusions.ts`).
 */
import { routeIdParamsSchema } from "@/lib/route-id-params";
import {
  lodgeCentralLinkBodySchema,
  lodgeCreateConnectionBodySchema,
  lodgeRosterSettingsBodySchema,
  lodgeSettingsBodySchema,
  lodgeSettingsQuerySchema,
  lodgeUpdateConnectionBodySchema,
  otherLodgeUpdateConnectionBodySchema,
} from "@/lib/admin-lodge-schemas/setup";
import {
  ADMIN_LODGE_CENTRAL_LINK_CONNECTION_SHAPE,
  ADMIN_LODGE_CONNECTION_SHAPE,
  ADMIN_LODGE_LIST_CONNECTION_SHAPE,
  ADMIN_LODGE_ROSTER_SETTINGS_CONNECTION_SHAPE,
  ADMIN_LODGE_SETTINGS_CONNECTION_SHAPE,
  ADMIN_LODGE_SETTINGS_SAVED_CONNECTION_SHAPE,
  ADMIN_OTHER_LODGE_HIDDEN_CONNECTION_SHAPE,
  ADMIN_OTHER_LODGE_LIST_CONNECTION_SHAPE,
  ADMIN_OTHER_LODGE_SAVED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/lodge-setup";

import type { McpAction } from "../catalogue";

// The handlers name these explicitly in `requireAdmin({ permission })`.
const LODGE_VIEW = { area: "lodge", level: "view" } as const;
const LODGE_EDIT = { area: "lodge", level: "edit" } as const;

export const LODGE_SETUP_MCP_ACTIONS: readonly McpAction[] = [
  // --- Lodges ----------------------------------------------------------------
  {
    // The route admits any administrator but answers lodge detail only with
    // `lodge:view`; the entry keeps the path's stricter rule, failing closed.
    id: "list_lodges_for_officers",
    title: "List the club's lodges (officer)",
    summary:
      "Officer: every lodge the club runs, active or not, under `lodges`: id, name, slug, whether active, street address and travel note. The `id` is the `lodgeId` the other lodge actions take. Door codes are never sent.",
    method: "GET",
    path: "/api/admin/lodges",
    kind: "read",
    returns: ADMIN_LODGE_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_lodge",
    title: "Create a lodge",
    summary:
      "Officer: adds a lodge with its name, nightly guest `capacity`, and optionally its address, travel note and whether it is active. Its settings row is created with it. A door code can be set only on the website. Answers the new lodge under `lodge`.",
    method: "POST",
    path: "/api/admin/lodges",
    body: lodgeCreateConnectionBodySchema,
    kind: "destructive",
    returns: ADMIN_LODGE_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },
  {
    id: "update_lodge",
    title: "Change or deactivate a lodge",
    summary:
      "Officer: changes a lodge (`id` from `list_lodges_for_officers`): name, address, travel note, or `active`. Deactivating is refused, listing what depends on the lodge, unless `force` is sent after the officer agrees. A door code can be changed only on the website. Answers the lodge under `lodge`.",
    method: "PATCH",
    path: "/api/admin/lodges/[id]",
    params: routeIdParamsSchema,
    body: lodgeUpdateConnectionBodySchema,
    kind: "destructive",
    returns: ADMIN_LODGE_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },

  // --- Central-server link ---------------------------------------------------
  {
    id: "get_lodge_central_link",
    title: "Read a lodge's central-server link",
    summary:
      "Officer: which lodge in the Alpine Central Server's registry a lodge (`id` from `list_lodges_for_officers`) is: its saved `centralLodgeId`, the central lodges the club owns (`ownedLodges`, null until downloaded), which one it answers for, another local lodge holding the link, a suggested link, whether Other lodges sharing is on and whether the site is registered with the central server.",
    method: "GET",
    path: "/api/admin/lodges/[id]/central-lodge",
    params: routeIdParamsSchema,
    kind: "read",
    returns: ADMIN_LODGE_CENTRAL_LINK_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_VIEW,
  },
  {
    id: "set_lodge_central_link",
    title: "Link a lodge to the central server",
    summary:
      "Officer: links a lodge (`id` from `list_lodges_for_officers`) to one of the central lodges the club owns (`centralLodgeId` from `ownedLodges` in `get_lodge_central_link`), or unlinks it with null. Refused if another lodge holds that link. Answers the link as `get_lodge_central_link` does.",
    method: "PUT",
    path: "/api/admin/lodges/[id]/central-lodge",
    params: routeIdParamsSchema,
    body: lodgeCentralLinkBodySchema,
    kind: "destructive",
    returns: ADMIN_LODGE_CENTRAL_LINK_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },

  // --- Member roster name detail ---------------------------------------------
  {
    id: "get_lodge_roster_settings",
    title: "Read a lodge's roster name detail",
    summary:
      "Officer: how much of each name the member lodge roster shows at a lodge (`id` from `list_lodges_for_officers`): its own choice (null uses the default), the default, and whether the roster is switched on.",
    method: "GET",
    path: "/api/admin/lodges/[id]/roster-settings",
    params: routeIdParamsSchema,
    kind: "read",
    returns: ADMIN_LODGE_ROSTER_SETTINGS_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_VIEW,
  },
  {
    id: "update_lodge_roster_settings",
    title: "Change a lodge's roster name detail",
    summary:
      "Officer: sets how much of each name the member lodge roster shows at a lodge (`id` from `list_lodges_for_officers`), or null for the default. This changes what members see of each other. Answers as `get_lodge_roster_settings`.",
    method: "PUT",
    path: "/api/admin/lodges/[id]/roster-settings",
    params: routeIdParamsSchema,
    body: lodgeRosterSettingsBodySchema,
    kind: "destructive",
    returns: ADMIN_LODGE_ROSTER_SETTINGS_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },

  // --- Lodge settings --------------------------------------------------------
  {
    id: "get_lodge_settings",
    title: "Read lodge settings",
    summary:
      "Officer: a lodge's nightly guest capacity (null when not set), school-group soft cap and the club-wide hut-leader lookahead in days, plus the club config's bed total. With `lodgeId` (from `list_lodges_for_officers`) it also says whether the lodge can take bookings (`setUpForBookings`) and the capacity it resolves to.",
    method: "GET",
    path: "/api/admin/lodge-settings",
    query: lodgeSettingsQuerySchema,
    kind: "read",
    returns: ADMIN_LODGE_SETTINGS_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_VIEW,
  },
  {
    id: "update_lodge_settings",
    title: "Change lodge settings",
    summary:
      "Officer: sets a lodge's nightly guest `capacity` (required; null clears it), and optionally its school-group soft cap and the club-wide hut-leader lookahead in days. Give `lodgeId` (from `list_lodges_for_officers`) for one lodge. Capacity changes what can be booked. Answers the saved settings.",
    method: "PUT",
    path: "/api/admin/lodge-settings",
    body: lodgeSettingsBodySchema,
    kind: "destructive",
    returns: ADMIN_LODGE_SETTINGS_SAVED_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },

  // --- Other lodges ----------------------------------------------------------
  {
    id: "list_other_lodges",
    title: "List Other lodges",
    summary:
      "Officer: the shared registry of other clubs' lodges (from the Alpine Central Server) under `otherLodges`: location, booking officer's name, booking page, facilities, beds, season dates (`YYYY-MM-DD`), non-member nightly rates in integer cents, amenities, whether this club owns it, and, for a row the server no longer lists, how many bookings and requests cite it. Also the owned lodges' names and the server version status.",
    method: "GET",
    path: "/api/admin/other-lodges",
    kind: "read",
    returns: ADMIN_OTHER_LODGE_LIST_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_VIEW,
  },
  {
    id: "update_other_lodge",
    title: "Change this club's Other lodges entry",
    summary:
      "Officer: changes this club's own entry in the Other lodges registry (`id` of an owned row from `list_other_lodges`); another club's entry is refused. Send only what changes: rates in integer cents, season dates `YYYY-MM-DD`, `amenities` replaces the whole list, `ratesFromFees` fills rates and dates from the Fees page. The booking officer's email address and phone number are changed on the website. The change is uploaded to the Alpine Central Server, which every club reads. Answers the row and the upload's outcome.",
    method: "PATCH",
    path: "/api/admin/other-lodges/[id]",
    params: routeIdParamsSchema,
    body: otherLodgeUpdateConnectionBodySchema,
    kind: "destructive",
    returns: ADMIN_OTHER_LODGE_SAVED_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },
  {
    id: "hide_other_lodge",
    title: "Hide an Other lodge the server no longer lists",
    summary:
      "Officer: hides a registry row the Alpine Central Server no longer lists (`id` of a row with `notOnCentralServer` in `list_other_lodges`). It stays on the bookings and requests that name it. Hiding is never undone. Answers `ok`.",
    method: "POST",
    path: "/api/admin/other-lodges/[id]/hide",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: ADMIN_OTHER_LODGE_HIDDEN_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },
];
