/**
 * Lodge maintenance: the maintenance report queue, its question set and
 * policy, the QR signs' on/off switch, and the food-order settings. Part of
 * the Lodge Operations officer actions (ALP-722): spread into `MCP_ACTIONS`.
 *
 * Kinds: every change here is `destructive`. A report's status and its photo
 * are another person's record (a deleted photo cannot be restored); the
 * question set, the report policy (it opens or closes the anonymous QR form),
 * a sign's switch and the food officer's address are club-wide configuration
 * (owner decision, #5305 comment 7093303964, item 2).
 *
 * The report `PATCH` takes one of two bodies, told apart by `action`; each is
 * its own action here, the route's branch with `action` fixed, so an app
 * names what it means to do.
 *
 * Minting or rotating a QR sign (`POST .../tokens`) answers the sign's bearer
 * link once, so it is never an action (`exclusions.ts`); the status read and
 * the pause/resume switch carry no token, hash or link.
 */
import { routeIdParamsSchema } from "@/lib/route-id-params";
import {
  maintenanceQuestionsBodySchema,
  maintenanceReportListQuerySchema,
  maintenanceReportPhotoDeleteBodySchema,
  maintenanceReportSettingsBodySchema,
  maintenanceReportStatusBodySchema,
  maintenanceSignActiveBodySchema,
} from "@/lib/admin-lodge-schemas/maintenance";
import {
  ADMIN_FOOD_ORDER_SETTINGS_CONNECTION_SHAPE,
  ADMIN_MAINTENANCE_QUESTIONS_CONNECTION_SHAPE,
  ADMIN_MAINTENANCE_QUESTIONS_SAVED_CONNECTION_SHAPE,
  ADMIN_MAINTENANCE_REPORT_CONNECTION_SHAPE,
  ADMIN_MAINTENANCE_REPORT_LIST_CONNECTION_SHAPE,
  ADMIN_MAINTENANCE_SETTINGS_CONNECTION_SHAPE,
  ADMIN_MAINTENANCE_SETTINGS_SAVED_CONNECTION_SHAPE,
  ADMIN_MAINTENANCE_SIGN_LIST_CONNECTION_SHAPE,
  ADMIN_MAINTENANCE_SIGN_SWITCHED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/lodge-maintenance";

import type { McpAction } from "../catalogue";

// The handlers name these explicitly in `requireAdmin({ permission })`.
const LODGE_VIEW = { area: "lodge", level: "view" } as const;
const LODGE_EDIT = { area: "lodge", level: "edit" } as const;

export const LODGE_MAINTENANCE_MCP_ACTIONS: readonly McpAction[] = [
  // --- The maintenance report queue ------------------------------------------
  {
    id: "list_maintenance_reports",
    title: "List maintenance reports",
    summary:
      "Officer: one page of maintenance reports under `reports` (OPEN by default, oldest first): lodge, where it came from, status, summary, the reporter's name (the member, or the name a QR-sign reporter typed), the answers given, whether a photo is still held, resolution date and note. Also the active lodges, paging and how many reports are not yet resolved. Contact details are never sent.",
    method: "GET",
    path: "/api/admin/maintenance-reports",
    query: maintenanceReportListQuerySchema,
    kind: "read",
    returns: ADMIN_MAINTENANCE_REPORT_LIST_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_VIEW,
  },
  {
    id: "get_maintenance_report",
    title: "Read a maintenance report",
    summary:
      "Officer: one maintenance report by `id` (from `list_maintenance_reports`), with the same fields as the list. The photo itself is not sent: only whether it is still held and its dates. The read is audited.",
    method: "GET",
    path: "/api/admin/maintenance-reports/[id]",
    params: routeIdParamsSchema,
    kind: "read",
    returns: ADMIN_MAINTENANCE_REPORT_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_VIEW,
  },
  {
    id: "set_maintenance_report_status",
    title: "Move a maintenance report's status",
    summary:
      "Officer: sets a maintenance report (`id` from `list_maintenance_reports`) to OPEN, IN_PROGRESS or RESOLVED, with an optional `note` of what was done, kept only while RESOLVED. Answers the report under `report`.",
    method: "PATCH",
    path: "/api/admin/maintenance-reports/[id]",
    params: routeIdParamsSchema,
    body: maintenanceReportStatusBodySchema,
    fixedBody: { action: "setStatus" },
    kind: "destructive",
    returns: ADMIN_MAINTENANCE_REPORT_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },
  {
    id: "delete_maintenance_report_photo",
    title: "Delete a maintenance report's photo",
    summary:
      "Officer: deletes a maintenance report's photo (`id` from `list_maintenance_reports`) ahead of the retention sweep, with an optional `reason`. It cannot be undone. Answers the report under `report`.",
    method: "PATCH",
    path: "/api/admin/maintenance-reports/[id]",
    params: routeIdParamsSchema,
    body: maintenanceReportPhotoDeleteBodySchema,
    fixedBody: { action: "deletePhoto" },
    kind: "destructive",
    returns: ADMIN_MAINTENANCE_REPORT_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },

  // --- The question set ------------------------------------------------------
  {
    id: "get_maintenance_report_questions",
    title: "Read the maintenance report questions",
    summary:
      "Officer: the questions the maintenance report form asks, in order: label, help text, type (SHORT_TEXT, LONG_TEXT, YES_NO, SINGLE_CHOICE), whether required, and a choice question's options; plus the editor's limits.",
    method: "GET",
    path: "/api/admin/maintenance-reports/questions",
    kind: "read",
    returns: ADMIN_MAINTENANCE_QUESTIONS_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_VIEW,
  },
  {
    id: "update_maintenance_report_questions",
    title: "Replace the maintenance report questions",
    summary:
      "Officer: replaces the whole question set, in order. Keep a question by sending its `id` from `get_maintenance_report_questions`; a question left out stops being asked (its past answers are kept). A SINGLE_CHOICE question needs at least two different options; other types take none. Answers the saved set.",
    method: "PUT",
    path: "/api/admin/maintenance-reports/questions",
    body: maintenanceQuestionsBodySchema,
    kind: "destructive",
    returns: ADMIN_MAINTENANCE_QUESTIONS_SAVED_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },

  // --- The maintenance report policy -----------------------------------------
  {
    id: "get_maintenance_report_settings",
    title: "Read the maintenance report policy",
    summary:
      "Officer: whether anyone may report through a lodge's QR sign without signing in, whether members and QR reporters may attach photos, how many days a photo is kept, and whether the QR form asks for a name and contact; plus the retention window's bounds.",
    method: "GET",
    path: "/api/admin/maintenance-reports/settings",
    kind: "read",
    returns: ADMIN_MAINTENANCE_SETTINGS_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_VIEW,
  },
  {
    id: "update_maintenance_report_settings",
    title: "Change the maintenance report policy",
    summary:
      "Officer: sets every maintenance report policy field at once (send the values from `get_maintenance_report_settings` with the change). `anonymousReportsEnabled` opens or closes the public QR form. Answers the saved policy.",
    method: "PUT",
    path: "/api/admin/maintenance-reports/settings",
    body: maintenanceReportSettingsBodySchema,
    kind: "destructive",
    returns: ADMIN_MAINTENANCE_SETTINGS_SAVED_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },

  // --- The QR signs ----------------------------------------------------------
  {
    id: "list_maintenance_report_signs",
    title: "List the lodges' QR report signs",
    summary:
      "Officer: each active lodge's maintenance report QR sign: whether it has one (`sign` null if never created), whether it is switched on, and when it was created, last replaced and last scanned. A new sign, or its link, is made only on the website.",
    method: "GET",
    path: "/api/admin/maintenance-reports/tokens",
    kind: "read",
    returns: ADMIN_MAINTENANCE_SIGN_LIST_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_VIEW,
  },
  {
    id: "set_maintenance_report_sign_active",
    title: "Pause or resume a lodge's QR report sign",
    summary:
      "Officer: switches a lodge's maintenance report QR sign off (`active` false) or back on (`lodgeId` from `list_maintenance_report_signs`). A pause is not a revocation: the same sign works again when resumed; replace a lost sign on the website. Answers `ok`.",
    method: "PATCH",
    path: "/api/admin/maintenance-reports/tokens",
    body: maintenanceSignActiveBodySchema,
    kind: "destructive",
    returns: ADMIN_MAINTENANCE_SIGN_SWITCHED_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },

  // --- Food-order settings ---------------------------------------------------
  {
    id: "get_food_order_settings",
    title: "Read the food-order settings",
    summary:
      "Officer: what the club calls its food officer (`officerLabel`). The officer's email address is not sent. Answers 404 while food orders are switched off.",
    method: "GET",
    path: "/api/admin/food-orders/settings",
    kind: "read",
    returns: ADMIN_FOOD_ORDER_SETTINGS_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_VIEW,
  },
];
