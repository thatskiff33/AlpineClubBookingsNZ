import type { ConfirmOptions } from "@/components/confirm-dialog";

/**
 * The one confirmation shown before a season is deleted, from both the Seasons
 * page and the Hut Fees section (#4973). Deleting a season cascades to its
 * nightly rate rows (`onDelete: Cascade` in `prisma/schema.prisma`), so the
 * prompt says so: those prices have to be re-entered before the nights book.
 */
export function seasonDeleteConfirmation(seasonName: string): ConfirmOptions {
  return {
    title: `Delete ${seasonName}?`,
    description:
      "All of this season's nightly rates will be deleted too. Deleting the season and its rates cannot be undone; rates must be re-entered before bookings can be priced for these nights.",
    confirmLabel: "Delete season",
    destructive: true,
  };
}
