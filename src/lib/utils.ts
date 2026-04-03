import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function getSeasonYear(date: Date = new Date()): number {
  const month = date.getMonth();
  const year = date.getFullYear();
  return month >= 3 ? year : year - 1;
}
