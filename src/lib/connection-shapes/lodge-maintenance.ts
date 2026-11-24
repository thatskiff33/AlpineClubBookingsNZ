/**
 * What the Lodge Operations maintenance and food-order settings officer
 * actions return (ALP-722, `INV-MCP-006`): the maintenance report queue and
 * one report, its question set and policy, the QR signs' status, and the
 * food-order settings. The catalogue entry and the route's `connectionJson`
 * both read these (`INV-SSOT`).
 *
 * Kept: what an officer's AI app needs to work the queue and change the
 * settings, including the reporting member's or the QR reporter's name.
 * Dropped:
 *
 * - a reporter's contact (`selfDeclaredContact`) and the reporting member's
 *   email address;
 * - the photo itself (`photo.dataUrl`): the image's bytes inline, megabytes
 *   an app cannot read as text. Whether a photo is still held, and its
 *   dates, are kept;
 * - the food officer's email address: a person's address an app has no need
 *   to read, so the save that sets it is website-only (`unread-value`);
 * - any QR sign token, hash or sign link: the sign status read has none, and
 *   minting a sign (which answers its link once) is website-only;
 * - row timestamps that mean nothing to an officer (`updatedAt`).
 *
 * Types only from the lib modules: nothing here reaches the database.
 */
import type { MaintenanceReportQuestion } from "@prisma/client";

import type { AdminListPage } from "@/lib/admin-list-page";
import { type ConnectionShapeFor, connectionShapeFor } from "@/lib/connection-projection";
import type { FoodOrderSettingsValues } from "@/lib/food-order-settings";
import type { mapMaintenanceReportForDetail, mapMaintenanceReportForList } from "@/lib/maintenance-report-admin";
import type { MaintenanceReportSettingsValues } from "@/lib/maintenance-report-settings";
import type { getLodgeMaintenanceTokenStatus } from "@/lib/maintenance-report-tokens";

// ---------------------------------------------------------------------------
// The maintenance report queue
// ---------------------------------------------------------------------------

type MaintenanceReportListItem = ReturnType<typeof mapMaintenanceReportForList>;
type MaintenanceReportDetail = ReturnType<typeof mapMaintenanceReportForDetail>;

// Nested shapes are plain constants, checked where a typed shape uses them.
const MAINTENANCE_REPORT_SHAPE = {
  id: true,
  lodge: { id: true, name: true },
  source: true,
  status: true,
  summary: true,
  selfDeclaredName: true,
  member: { id: true, firstName: true, lastName: true },
  photo: {
    contentType: true,
    capturedAt: true,
    expiresAt: true,
    deletedAt: true,
    deleteReason: true,
    retained: true,
  },
  resolvedAt: true,
  resolutionNote: true,
  createdAt: true,
  answers: { id: true, questionLabel: true, questionType: true, answerText: true },
} as const satisfies ConnectionShapeFor<MaintenanceReportListItem & MaintenanceReportDetail>;

/** One page of the queue, the active lodges to filter by, and how many reports are not yet resolved. */
export const ADMIN_MAINTENANCE_REPORT_LIST_CONNECTION_SHAPE = connectionShapeFor<
  AdminListPage & {
    reports: MaintenanceReportListItem[];
    lodges: Array<{ id: string; name: string }>;
    outstandingCount: number;
  }
>({
  reports: MAINTENANCE_REPORT_SHAPE,
  lodges: { id: true, name: true },
  page: true,
  pageSize: true,
  total: true,
  totalPages: true,
  outstandingCount: true,
});

/** One report, as read and as left by a status move or a photo deletion. */
export const ADMIN_MAINTENANCE_REPORT_CONNECTION_SHAPE = connectionShapeFor<{
  report: MaintenanceReportDetail | null;
}>({
  report: MAINTENANCE_REPORT_SHAPE,
});

// ---------------------------------------------------------------------------
// The question set
// ---------------------------------------------------------------------------

type MaintenanceQuestionAnswer = Pick<
  MaintenanceReportQuestion,
  "id" | "label" | "helpText" | "type" | "required" | "choices" | "sortOrder" | "active"
>;

const MAINTENANCE_QUESTION_SHAPE = {
  id: true,
  label: true,
  helpText: true,
  type: true,
  required: true,
  choices: true,
  sortOrder: true,
  active: true,
} as const satisfies ConnectionShapeFor<MaintenanceQuestionAnswer>;

/** The save's echo: the active set, in order. */
export const ADMIN_MAINTENANCE_QUESTIONS_SAVED_CONNECTION_SHAPE = connectionShapeFor<{
  questions: MaintenanceQuestionAnswer[];
}>({
  questions: MAINTENANCE_QUESTION_SHAPE,
});

/** The read adds the editor's bounds. */
export const ADMIN_MAINTENANCE_QUESTIONS_CONNECTION_SHAPE = connectionShapeFor<{
  questions: MaintenanceQuestionAnswer[];
  limits: {
    maxQuestions: number;
    maxLabelLength: number;
    maxHelpLength: number;
    maxChoices: number;
    maxChoiceLength: number;
  };
}>({
  questions: MAINTENANCE_QUESTION_SHAPE,
  limits: { maxQuestions: true, maxLabelLength: true, maxHelpLength: true, maxChoices: true, maxChoiceLength: true },
});

// ---------------------------------------------------------------------------
// The maintenance report policy
// ---------------------------------------------------------------------------

const MAINTENANCE_SETTINGS_SHAPE = {
  anonymousReportsEnabled: true,
  photosEnabled: true,
  anonymousPhotosEnabled: true,
  photoRetentionDays: true,
  anonymousContactPrompt: true,
} as const satisfies ConnectionShapeFor<MaintenanceReportSettingsValues>;

/** The save's echo. */
export const ADMIN_MAINTENANCE_SETTINGS_SAVED_CONNECTION_SHAPE = connectionShapeFor<{
  settings: MaintenanceReportSettingsValues;
}>({
  settings: MAINTENANCE_SETTINGS_SHAPE,
});

/** The read adds the retention window's bounds. */
export const ADMIN_MAINTENANCE_SETTINGS_CONNECTION_SHAPE = connectionShapeFor<{
  settings: MaintenanceReportSettingsValues;
  limits: { photoRetentionDaysMin: number; photoRetentionDaysMax: number };
}>({
  settings: MAINTENANCE_SETTINGS_SHAPE,
  limits: { photoRetentionDaysMin: true, photoRetentionDaysMax: true },
});

// ---------------------------------------------------------------------------
// The QR signs
// ---------------------------------------------------------------------------

/**
 * Each active lodge's sign: `sign` is null when none was ever created. The
 * status read selects no token or hash, and this shape names none.
 */
export const ADMIN_MAINTENANCE_SIGN_LIST_CONNECTION_SHAPE = connectionShapeFor<{
  signs: Array<{
    lodgeId: string;
    lodgeName: string;
    sign: Awaited<ReturnType<typeof getLodgeMaintenanceTokenStatus>>;
  }>;
}>({
  signs: {
    lodgeId: true,
    lodgeName: true,
    sign: { active: true, createdAt: true, rotatedAt: true, lastUsedAt: true },
  },
});

/** A sign paused or resumed. */
export const ADMIN_MAINTENANCE_SIGN_SWITCHED_CONNECTION_SHAPE = connectionShapeFor<{ ok: boolean }>({ ok: true });

// ---------------------------------------------------------------------------
// Food-order settings
// ---------------------------------------------------------------------------

/** The read, without the officer's address (see the module note). */
export const ADMIN_FOOD_ORDER_SETTINGS_CONNECTION_SHAPE = connectionShapeFor<{
  settings: FoodOrderSettingsValues;
}>({
  settings: { officerLabel: true },
});
