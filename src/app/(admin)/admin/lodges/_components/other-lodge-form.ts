import { isHttpUrl } from "@/lib/http-url";
import {
  OTHER_LODGE_BOUNDS,
  OTHER_LODGE_ROOM_TYPES,
  amenitiesInputSchema,
  type AdminOtherLodge,
  type OtherLodgeBooleanField,
  type OtherLodgeDateField,
  type OtherLodgeTextField,
  type OtherLodgeWholeNumberField,
  type SerializedOtherLodge,
} from "@/lib/other-lodges";

// The other-lodge editor's FORM MODEL, split out of `other-lodges-panel.tsx` to
// keep that component inside its size budget: the field specs and labels, the
// form state, and the conversions between it, the stored lodge and the PATCH
// payload. Pure functions and constants only; the panel owns every hook.

// The API's own shape, not a hand-copied one: a column added to the shared
// field list in `@/lib/other-lodges` fails to compile here until the form
// carries it, instead of being silently dropped from the editor (#50). The
// list row is the ADMIN shape (#52): another club's officer phone is not in
// it, and `owned` is the route's answer to whether this site may edit it.
export type OtherLodgeRecord = AdminOtherLodge;
type OtherLodgePayload = Omit<SerializedOtherLodge, "id" | "createdAt" | "updatedAt">;

// EVERY EDITOR LABEL IS A `Record` OVER THE SHARED FIELD TYPE, so a field that
// is stored, serialized and uploaded but missing here is a compile error — the
// one list cannot gain a 15th field that the editor silently has no input for.
// Lengths come from the same `OTHER_LODGE_BOUNDS` the API validates with.
type TextInputSpec = {
  label: string;
  maxLength: number;
  type?: "email" | "url";
  placeholder?: string;
};
export const TEXT_FIELDS: Record<OtherLodgeTextField, TextInputSpec> = {
  location: { label: "Location", maxLength: OTHER_LODGE_BOUNDS.location },
  bookingOfficerName: {
    label: "Booking officer's name",
    maxLength: OTHER_LODGE_BOUNDS.bookingOfficerName,
  },
  bookingOfficerEmail: {
    label: "Booking officer's email",
    maxLength: OTHER_LODGE_BOUNDS.bookingOfficerEmail,
    type: "email",
  },
  bookingOfficerPhone: {
    label: "Booking officer's phone",
    maxLength: OTHER_LODGE_BOUNDS.bookingOfficerPhone,
  },
  siteUrl: {
    label: "Non-member booking page URL",
    maxLength: OTHER_LODGE_BOUNDS.siteUrl,
    type: "url",
    placeholder: "https://",
  },
  cancellationPeriod: {
    label: "Cancellation period",
    maxLength: OTHER_LODGE_BOUNDS.cancellationPeriod,
  },
};
export const WHOLE_NUMBER_FIELDS: Record<OtherLodgeWholeNumberField, string> = {
  bedCapacity: "Bed capacity",
  doubleBeds: "Double beds",
  singleBeds: "Single beds",
  minutesWalkToLodge: "Minutes' walk to the lodge",
};
// A `Record` over the stored values too, so a room type added to the shared
// list cannot go without a radio button here.
const ROOM_TYPE_LABELS: Record<(typeof OTHER_LODGE_ROOM_TYPES)[number], string> = {
  ROOM: "Room",
  DORMITORY: "Dormitory",
};
type RoomTypeChoice = (typeof OTHER_LODGE_ROOM_TYPES)[number] | "";
export const ROOM_TYPE_CHOICES: ReadonlyArray<readonly [RoomTypeChoice, string]> = [
  ...OTHER_LODGE_ROOM_TYPES.map((value) => [value, ROOM_TYPE_LABELS[value]] as const),
  ["", "Not stated"],
];
export const DATE_FIELDS: Record<OtherLodgeDateField, string> = {
  winterSeasonStart: "Winter season starts",
  summerSeasonStart: "Summer season starts",
};
export const FACILITY_LABELS: Record<OtherLodgeBooleanField, string> = {
  requiresLodgeCustodian: "Requires a lodge custodian",
  freeWifi: "Free wifi",
  quietRoom: "Quiet room",
  dryingRoom: "Drying room",
  sharedKitchen: "Shared kitchen",
  wheelchairAccessible: "Wheelchair accessible",
  breakfastIncluded: "Breakfast included",
  lunchIncluded: "Lunch included",
  dinnerIncluded: "Dinner included",
  skiWorkshopArea: "Ski workshop area",
  gamesRoom: "Games room",
};
export const TEXT_FIELD_NAMES = Object.keys(TEXT_FIELDS) as OtherLodgeTextField[];
export const WHOLE_NUMBER_FIELD_NAMES = Object.keys(
  WHOLE_NUMBER_FIELDS,
) as OtherLodgeWholeNumberField[];
export const DATE_FIELD_NAMES = Object.keys(DATE_FIELDS) as OtherLodgeDateField[];
export const FACILITY_FIELDS = Object.keys(FACILITY_LABELS) as OtherLodgeBooleanField[];

export type AmenityFormRow = { name: string; description: string };

export type OtherLodgeFormState = {
  name: string;
  /** As typed: digits, or "" for not set. Parsed on save. */
  numbers: Record<OtherLodgeWholeNumberField, string>;
  roomType: RoomTypeChoice;
  text: Record<OtherLodgeTextField, string>;
  /** `YYYY-MM-DD` from a date input, or "" — never a `Date`. */
  dates: Record<OtherLodgeDateField, string>;
  facilities: Record<OtherLodgeBooleanField, boolean>;
  amenities: AmenityFormRow[];
};

/** `{ [field]: value(field) }` typed over the field union, for the records above. */
function recordOf<K extends string, V>(keys: readonly K[], value: (key: K) => V) {
  return Object.fromEntries(keys.map((key) => [key, value(key)])) as Record<K, V>;
}

export const emptyForm: OtherLodgeFormState = {
  name: "",
  numbers: recordOf(WHOLE_NUMBER_FIELD_NAMES, () => ""),
  roomType: "",
  text: recordOf(TEXT_FIELD_NAMES, () => ""),
  dates: recordOf(DATE_FIELD_NAMES, () => ""),
  facilities: recordOf(FACILITY_FIELDS, () => false),
  amenities: [],
};

export function formFromLodge(lodge: OtherLodgeRecord): OtherLodgeFormState {
  return {
    name: lodge.name,
    numbers: recordOf(WHOLE_NUMBER_FIELD_NAMES, (field) =>
      lodge[field] === null ? "" : String(lodge[field]),
    ),
    roomType: lodge.roomType ?? "",
    text: recordOf(TEXT_FIELD_NAMES, (field) => lodge[field] ?? ""),
    dates: recordOf(DATE_FIELD_NAMES, (field) => lodge[field] ?? ""),
    facilities: recordOf(FACILITY_FIELDS, (field) => lodge[field]),
    amenities: lodge.amenities.map((a) => ({
      name: a.name,
      description: a.description ?? "",
    })),
  };
}

// Blank text fields save as null; whole numbers parse to an integer or null;
// dates travel as the `YYYY-MM-DD` string the input holds. The return type is
// the API's shape, so a missing field is a compile error.
export function formPayload(form: OtherLodgeFormState): OtherLodgePayload {
  return {
    name: form.name.trim(),
    ...recordOf(WHOLE_NUMBER_FIELD_NAMES, (field) => {
      const value = form.numbers[field].trim();
      return value === "" ? null : Number(value);
    }),
    roomType: form.roomType || null,
    ...recordOf(TEXT_FIELD_NAMES, (field) => form.text[field].trim() || null),
    ...recordOf(DATE_FIELD_NAMES, (field) => form.dates[field].trim() || null),
    ...form.facilities,
    amenities: form.amenities.map((a) => ({
      name: a.name.trim(),
      description: a.description.trim() || null,
    })),
  };
}

/**
 * The inline message for a form the API would refuse, or null when it is fine.
 * The amenity list is checked with the API's OWN schema rather than a re-typed
 * copy of its rules, so "needs a name", "unique ignoring case" and the per-lodge
 * cap can only ever disagree with the server by not being run.
 */
export function formProblem(form: OtherLodgeFormState): string | null {
  // No name check: the name is read-only and always the stored one (#52).
  for (const field of WHOLE_NUMBER_FIELD_NAMES) {
    const value = form.numbers[field].trim();
    if (value !== "" && !/^\d+$/.test(value)) {
      return `${WHOLE_NUMBER_FIELDS[field]} must be a whole number.`;
    }
    // Mirror the server's upper bound so an unrealistic value gets a clear
    // inline message instead of a generic "Invalid input" from the API.
    if (value !== "" && Number(value) > OTHER_LODGE_BOUNDS.wholeNumberMax) {
      return `${WHOLE_NUMBER_FIELDS[field]} looks too large. Enter a realistic number.`;
    }
  }
  const siteUrl = form.text.siteUrl.trim();
  if (siteUrl && !isHttpUrl(siteUrl)) {
    return "The non-member booking page URL must start with http:// or https://.";
  }
  const amenities = amenitiesInputSchema.safeParse(formPayload(form).amenities);
  if (!amenities.success) {
    const [issue] = amenities.error.issues;
    const row = typeof issue?.path[0] === "number" ? ` (amenity ${issue.path[0] + 1})` : "";
    return `${issue?.message ?? "Check the amenities."}${row}`;
  }
  return null;
}
