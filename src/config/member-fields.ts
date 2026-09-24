/**
 * Client-safe constants and types for the optional member-field visibility
 * settings. Kept free of server-only imports (prisma, logger) so both client
 * components and the server loaders in src/lib/member-fields-settings.ts can use
 * them, mirroring the src/config/modules.ts split.
 */

export const MEMBER_FIELD_KEYS = [
  "showTitle",
  "showGender",
  "showOccupation",
  "showDietaryRequirements",
] as const;

export type MemberFieldKey = (typeof MEMBER_FIELD_KEYS)[number];
export type MemberFieldsSettingsValues = Record<MemberFieldKey, boolean>;

export const DEFAULT_MEMBER_FIELDS_SETTINGS: MemberFieldsSettingsValues = {
  showTitle: true,
  showGender: true,
  showOccupation: true,
  // Special-category data (#2941, INV-PRIV-022): a club opts IN, so this one
  // defaults OFF — on a missing row, a read failure, an upgrade and a new row.
  showDietaryRequirements: false,
};

export interface MemberFieldDefinition {
  key: MemberFieldKey;
  label: string;
  description: string;
}

export const MEMBER_FIELD_DEFINITIONS: Record<
  MemberFieldKey,
  MemberFieldDefinition
> = {
  showTitle: {
    key: "showTitle",
    label: "Title",
    description:
      "Salutation (Mr, Ms, Mrs, etc.) on the member record, onboarding, and CSV.",
  },
  showGender: {
    key: "showGender",
    label: "Gender",
    description:
      "Gender on the member record, onboarding, and CSV. Turn off if the club does not need to collect it.",
  },
  showOccupation: {
    key: "showOccupation",
    label: "Occupation",
    description:
      "Free-text occupation. Adult members only; collected at onboarding and editable in the member's profile.",
  },
  showDietaryRequirements: {
    key: "showDietaryRequirements",
    label: "Dietary/allergy information",
    description:
      "Free-text dietary and allergy information, for members of any age. Collected at onboarding, editable in the member's profile and by membership admins, and included in member CSV import and export. Privacy-sensitive: nobody else sees it. Off by default; turning it off hides it without deleting what is stored.",
  },
};
