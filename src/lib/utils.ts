import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function getSeasonYear(date: Date): number {
  const month = date.getMonth(); // 0-indexed
  const year = date.getFullYear();
  // Season year: April to March. If month >= April (3), seasonYear = currentYear; else currentYear - 1
  return month >= 3 ? year : year - 1;
}
