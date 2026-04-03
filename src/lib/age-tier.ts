import type { AgeTier } from "@prisma/client";

export function computeAge(dateOfBirth: Date, referenceDate: Date = new Date()): number {
  let age = referenceDate.getFullYear() - dateOfBirth.getFullYear();
  const monthDiff = referenceDate.getMonth() - dateOfBirth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && referenceDate.getDate() < dateOfBirth.getDate())) {
    age--;
  }
  return age;
}

export function computeAgeTier(
  dateOfBirth: Date,
  referenceDate: Date = new Date()
): AgeTier {
  const age = computeAge(dateOfBirth, referenceDate);
  if (age < 13) return "CHILD";
  if (age < 18) return "YOUTH";
  return "ADULT";
}

export function computeSeasonYear(date: Date = new Date()): number {
  const month = date.getMonth(); // 0-indexed: April = 3
  const year = date.getFullYear();
  return month >= 3 ? year : year - 1;
}
