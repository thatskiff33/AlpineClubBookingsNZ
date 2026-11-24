/**
 * What the Lodge Operations setup officer actions return (ALP-722,
 * `INV-MCP-006`): the club's lodges, one lodge's central-server link and
 * member roster name detail, the lodge settings, and the Other lodges
 * registry. The catalogue entry and the route's `connectionJson` both read
 * these (`INV-SSOT`).
 *
 * Kept: what an officer's AI app needs to read and change the setting.
 * Dropped: a lodge's door code (a physical-access secret, website-only),
 * another club's booking officer's email address and phone number, and row
 * timestamps.
 *
 * Types only from the lib modules: nothing here reaches the database.
 */
import type { DisplayNameGranularity } from "@prisma/client";

import type { labelOwnedLodges } from "@/lib/central-lodge-link";
import { type ConnectionShapeFor, connectionShapeFor } from "@/lib/connection-projection";
import type { SerializedLodge } from "@/lib/lodges";
import type { AdminOtherLodge, AdminOtherLodgesResponse } from "@/lib/other-lodges";
import type { UploadAfterSave } from "@/lib/servernz-upload-after-save";

// ---------------------------------------------------------------------------
// Lodges
// ---------------------------------------------------------------------------

// Nested shapes are plain constants, checked where a typed shape uses them.
const LODGE_SHAPE = {
  id: true,
  name: true,
  slug: true,
  active: true,
  address: true,
  travelNote: true,
} as const satisfies ConnectionShapeFor<SerializedLodge>;

/** The officer's lodge list. An officer without `lodge:view` is never offered it. */
export const ADMIN_LODGE_LIST_CONNECTION_SHAPE = connectionShapeFor<{ lodges: SerializedLodge[] }>({
  lodges: LODGE_SHAPE,
});

/** A created or changed lodge. */
export const ADMIN_LODGE_CONNECTION_SHAPE = connectionShapeFor<{ lodge: SerializedLodge }>({
  lodge: LODGE_SHAPE,
});

// ---------------------------------------------------------------------------
// One lodge's central-server link
// ---------------------------------------------------------------------------

/** The central-lodge card's payload: the route builds its answer as this type. */
export interface LodgeCentralLinkAnswer {
  lodgeId: string;
  lodgeName: string;
  lodgeActive: boolean;
  centralLodgeId: string | null;
  ownedLodges: Awaited<ReturnType<typeof labelOwnedLodges>> | null;
  answersForCentralLodgeId: string | null;
  linkHeldBy: string | null;
  suggestedCentralLodgeId: string | null;
  otherLodgesEnabled: boolean;
  registeredWithCentralServer: boolean;
}

export const ADMIN_LODGE_CENTRAL_LINK_CONNECTION_SHAPE = connectionShapeFor<LodgeCentralLinkAnswer>({
  lodgeId: true,
  lodgeName: true,
  lodgeActive: true,
  centralLodgeId: true,
  ownedLodges: { id: true, name: true, label: true },
  answersForCentralLodgeId: true,
  linkHeldBy: true,
  suggestedCentralLodgeId: true,
  otherLodgesEnabled: true,
  registeredWithCentralServer: true,
});

// ---------------------------------------------------------------------------
// One lodge's member roster name detail
// ---------------------------------------------------------------------------

/** The roster-settings card's payload: the route builds its answer as this type. */
export interface LodgeRosterSettingsAnswer {
  lodgeId: string;
  lodgeName: string;
  rosterNameGranularity: DisplayNameGranularity | null;
  defaultRosterNameGranularity: DisplayNameGranularity;
  memberLodgeRosterEnabled: boolean;
}

export const ADMIN_LODGE_ROSTER_SETTINGS_CONNECTION_SHAPE = connectionShapeFor<LodgeRosterSettingsAnswer>({
  lodgeId: true,
  lodgeName: true,
  rosterNameGranularity: true,
  defaultRosterNameGranularity: true,
  memberLodgeRosterEnabled: true,
});

// ---------------------------------------------------------------------------
// Lodge settings
// ---------------------------------------------------------------------------

/** The save's echo, and the read without a lodge. */
export interface LodgeSettingsSavedAnswer {
  capacity: number | null;
  hutLeaderLookaheadDays: number;
  schoolGroupSoftCap: number | null;
  clubConfigCapacity: number;
}

/** The read of one lodge adds whether it can take a booking, and the capacity it resolves to. */
export type LodgeSettingsAnswer = LodgeSettingsSavedAnswer & {
  setUpForBookings?: boolean;
  resolvedCapacity?: number;
};

const LODGE_SETTINGS_SAVED_FIELDS = {
  capacity: true,
  hutLeaderLookaheadDays: true,
  schoolGroupSoftCap: true,
  clubConfigCapacity: true,
} as const satisfies ConnectionShapeFor<LodgeSettingsSavedAnswer>;

export const ADMIN_LODGE_SETTINGS_SAVED_CONNECTION_SHAPE =
  connectionShapeFor<LodgeSettingsSavedAnswer>(LODGE_SETTINGS_SAVED_FIELDS);

export const ADMIN_LODGE_SETTINGS_CONNECTION_SHAPE = connectionShapeFor<LodgeSettingsAnswer>({
  ...LODGE_SETTINGS_SAVED_FIELDS,
  setUpForBookings: true,
  resolvedCapacity: true,
});

// ---------------------------------------------------------------------------
// Other lodges
// ---------------------------------------------------------------------------

/**
 * One registry row. Named field by field, so a column the registry gains
 * later reaches no app until it is added here. `bookingOfficerEmail` and
 * `bookingOfficerPhone` are another club's officer's contact details, and
 * `createdAt`/`updatedAt` mean nothing to an officer.
 */
const OTHER_LODGE_SHAPE = {
  id: true,
  name: true,
  location: true,
  bookingOfficerName: true,
  siteUrl: true,
  cancellationPeriod: true,
  bedCapacity: true,
  doubleBeds: true,
  singleBeds: true,
  minutesWalkToLodge: true,
  roomType: true,
  requiresLodgeCustodian: true,
  freeWifi: true,
  quietRoom: true,
  dryingRoom: true,
  sharedKitchen: true,
  wheelchairAccessible: true,
  breakfastIncluded: true,
  lunchIncluded: true,
  dinnerIncluded: true,
  skiWorkshopArea: true,
  gamesRoom: true,
  winterSeasonStart: true,
  winterSeasonEnd: true,
  summerSeasonStart: true,
  summerSeasonEnd: true,
  winterRateUnder5Cents: true,
  winterRate5To11Cents: true,
  winterRate12To17Cents: true,
  winterRateAdultCents: true,
  summerRateUnder5Cents: true,
  summerRate5To11Cents: true,
  summerRate12To17Cents: true,
  summerRateAdultCents: true,
  amenities: { name: true, description: true },
  owned: true,
  renamable: true,
  ratesFromFees: true,
  feesProblem: true,
  notOnCentralServer: { bookings: true, bookingRequests: true },
} as const satisfies ConnectionShapeFor<AdminOtherLodge>;

/** Each row's fields beyond its data depend on whether the club owns it (`oneOfSeveralAnswers` in the tests). */
export const ADMIN_OTHER_LODGE_LIST_CONNECTION_SHAPE = connectionShapeFor<AdminOtherLodgesResponse>({
  otherLodges: OTHER_LODGE_SHAPE,
  ownedLodgeNames: true,
  serverVersionStatus: true,
});

/** A save: the row as it now is, and what uploading it to the central server came to (absent when nothing changed). */
export const ADMIN_OTHER_LODGE_SAVED_CONNECTION_SHAPE = connectionShapeFor<{
  otherLodge: AdminOtherLodge;
  upload?: { status: UploadAfterSave["status"]; sent?: number; accepted?: number };
}>({
  otherLodge: OTHER_LODGE_SHAPE,
  upload: { status: true, sent: true, accepted: true },
});

/** Hiding a row the central server no longer lists. */
export const ADMIN_OTHER_LODGE_HIDDEN_CONNECTION_SHAPE = connectionShapeFor<{ ok: boolean }>({ ok: true });
