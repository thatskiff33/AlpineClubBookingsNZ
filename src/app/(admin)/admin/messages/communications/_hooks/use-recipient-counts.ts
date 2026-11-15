"use client";

import { useEffect, useState } from "react";
import type { BulkEmailCategory } from "@/lib/email/bulk-audience";

/**
 * What a send would reach, as GET `/api/admin/communications/send?recipientFilter=…&category=…`
 * returns it: counts only, never addresses (#4964, #4987).
 */
export interface RecipientCounts {
  totalRecipients: number;
  eligibleRecipients: number;
  optedOut: number;
  neverOptedIn: number;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Reads the count for an audience and a kind of message, from the same query the
 * send uses. A GET: it sends nothing and spends none of the hourly quota.
 * `null` when the count could not be read.
 */
export async function fetchRecipientCounts(
  recipientFilter: string,
  category: BulkEmailCategory,
): Promise<RecipientCounts | null> {
  try {
    const params = new URLSearchParams({ recipientFilter, category });
    const res = await fetch(`/api/admin/communications/send?${params}`);
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<RecipientCounts>;
    if (!isCount(data.eligibleRecipients) || !isCount(data.totalRecipients)) {
      return null;
    }
    return {
      totalRecipients: data.totalRecipients,
      eligibleRecipients: data.eligibleRecipients,
      optedOut: isCount(data.optedOut) ? data.optedOut : 0,
      neverOptedIn: isCount(data.neverOptedIn) ? data.neverOptedIn : 0,
    };
  } catch {
    return null;
  }
}

/**
 * #4987: "opted out" is said only of members who turned the kind of message
 * off; a member with no saved preferences "never opted in". Shared by the live
 * count, the confirmation and the post-send message so the three read alike.
 * Empty when nobody was excluded.
 */
export function describeExcluded({
  optedOut,
  neverOptedIn,
}: Pick<RecipientCounts, "optedOut" | "neverOptedIn">) {
  const parts: string[] = [];
  if (optedOut > 0) parts.push(`${optedOut} opted out`);
  if (neverOptedIn > 0) parts.push(`${neverOptedIn} never opted in`);
  return parts.join(", ");
}

/** {@link describeExcluded} in brackets after a sentence's count, or nothing. */
export function excludedSuffix(
  counts: Pick<RecipientCounts, "optedOut" | "neverOptedIn">,
) {
  const excluded = describeExcluded(counts);
  return excluded ? ` (${excluded})` : "";
}

export function peopleCount(count: number) {
  return `${count} ${count === 1 ? "person" : "people"}`;
}

export type RecipientPreview =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; counts: RecipientCounts };

/**
 * The live count beside the compose form. It re-reads whenever the audience or
 * the kind of message changes, and drops an answer that a newer choice has
 * already replaced. Nothing is read until a kind of message is chosen.
 */
export function useRecipientPreview(
  recipientFilter: string,
  category: BulkEmailCategory | null,
): RecipientPreview {
  const [preview, setPreview] = useState<{
    key: string;
    result: RecipientCounts | null;
  } | null>(null);
  const key = category ? `${recipientFilter}|${category}` : null;

  useEffect(() => {
    if (!category || !key) return;
    let stale = false;
    fetchRecipientCounts(recipientFilter, category).then((result) => {
      if (!stale) setPreview({ key, result });
    });
    return () => {
      stale = true;
    };
  }, [recipientFilter, category, key]);

  if (!key) return { status: "idle" };
  // An answer for an earlier choice is never shown against the current one.
  if (!preview || preview.key !== key) return { status: "loading" };
  return preview.result
    ? { status: "ready", counts: preview.result }
    : { status: "failed" };
}
