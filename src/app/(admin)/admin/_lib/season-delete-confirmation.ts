import type { ConfirmOptions } from "@/components/confirm-dialog";

/**
 * The one confirmation shown before a season is deleted, from both the Seasons
 * page and the Hut Fees section (#4973). Deleting a season cascades to its
 * nightly rate rows (`onDelete: Cascade` in `prisma/schema.prisma`), so the
 * prompt says so, and that the season and its rates would have to be set up
 * again.
 */
export function seasonDeleteConfirmation(seasonName: string): ConfirmOptions {
  return {
    title: `Delete ${seasonName}?`,
    description:
      "All of this season's nightly rates will be deleted too. Deleting a season cannot be undone: the season and its rates would need to be set up again.",
    confirmLabel: "Delete season",
    destructive: true,
  };
}
