/**
 * Refresh one admin page after a change (epic #4468, C3 #4800).
 *
 * The path comes from `adminPageCachePath`: the URL of the page's file. While
 * the switch is off, a moved page is still opened at its old URL, but a
 * `beforeFiles` rewrite serves the file at the hub URL, and Next tags that
 * render with the file's path. Refreshing the old URL would leave it stale.
 * Nothing is moved yet, so today the path is the one the call used to name.
 *
 * Relative imports only, apart from `next/cache` (see `release.ts`). This file
 * is not imported by `index.ts`, so the client sidebar can import `samePage`
 * from there without pulling `revalidatePath` into the browser bundle.
 */
import { revalidatePath } from "next/cache";
import { adminPageCachePath, type AdminPageId } from "./index";

export function revalidateAdminPage(id: AdminPageId): void {
  revalidatePath(adminPageCachePath(id));
}
