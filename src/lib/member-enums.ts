import { z } from "zod";
import type { Gender, Title } from "@prisma/client";

/**
 * Shared validators, option lists, and display labels for the Member `gender`
 * and `title` enums. The Prisma enums (in schema.prisma) remain the source of
 * truth: the `Record<Gender, string>` / `Record<Title, string>` label maps are
 * exhaustive, so adding a value to the Prisma enum forces a matching label
 * here. Prisma is imported as a type only so this module stays safe to bundle
 * in client components (the runtime `@prisma/client` is server-only).
 */

export const GENDER_LABELS: Record<Gender, string> = {
  MALE: "Male",
  FEMALE: "Female",
  OTHER: "Other",
};

export const TITLE_LABELS: Record<Title, string> = {
  MR: "Mr",
  MS: "Ms",
  MRS: "Mrs",
  MISS: "Miss",
  MASTER: "Master",
  DR: "Dr",
  REV: "Rev",
};

export const GENDER_VALUES = Object.keys(GENDER_LABELS) as [
  Gender,
  ...Gender[],
];
export const TITLE_VALUES = Object.keys(TITLE_LABELS) as [Title, ...Title[]];

export const genderEnum = z.enum(GENDER_VALUES);
export const titleEnum = z.enum(TITLE_VALUES);

export interface EnumOption<T extends string> {
  value: T;
  label: string;
}

export const GENDER_OPTIONS: EnumOption<Gender>[] = GENDER_VALUES.map(
  (value) => ({ value, label: GENDER_LABELS[value] }),
);

export const TITLE_OPTIONS: EnumOption<Title>[] = TITLE_VALUES.map((value) => ({
  value,
  label: TITLE_LABELS[value],
}));

/** Display the human-readable label for a stored gender value (or "" if null). */
export function formatGenderLabel(value: Gender | null | undefined): string {
  return value ? GENDER_LABELS[value] : "";
}

/** Display the human-readable label for a stored title value (or "" if null). */
export function formatTitleLabel(value: Title | null | undefined): string {
  return value ? TITLE_LABELS[value] : "";
}

/**
 * Parse a free-text gender value (from CSV import) into the enum, accepting
 * either the stored value (e.g. "MALE") or the display label (e.g. "Male"),
 * case-insensitively. Returns `null` for blank input and `undefined` when the
 * value is not recognised so callers can surface a validation error.
 */
export function parseGenderValue(
  value: string | null | undefined,
): Gender | null | undefined {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return null;
  return (
    GENDER_VALUES.find(
      (candidate) =>
        candidate.toLowerCase() === normalized ||
        GENDER_LABELS[candidate].toLowerCase() === normalized,
    ) ?? undefined
  );
}

/**
 * Parse a free-text title value (from CSV import) into the enum, accepting
 * either the stored value (e.g. "MR") or the display label (e.g. "Mr"),
 * case-insensitively. A trailing full stop (e.g. "Mr.") is ignored. Returns
 * `null` for blank input and `undefined` for an unrecognised value.
 */
export function parseTitleValue(
  value: string | null | undefined,
): Title | null | undefined {
  const normalized = (value ?? "").trim().replace(/\.$/, "").toLowerCase();
  if (!normalized) return null;
  return (
    TITLE_VALUES.find(
      (candidate) =>
        candidate.toLowerCase() === normalized ||
        TITLE_LABELS[candidate].toLowerCase() === normalized,
    ) ?? undefined
  );
}
