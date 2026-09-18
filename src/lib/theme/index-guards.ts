/*
 * Re-export of the shared `must` guard (`@/lib/indexed-access`) for the
 * theme/* modules' `noUncheckedIndexedAccess` migration (#2800, programme
 * #2694). Kept as a named local module so theme/* imports stay relative
 * (`./index-guards`) like every other intra-theme import — the logic and its
 * test live in the one shared home (INV-SSOT), not copied here.
 */
export { must } from "@/lib/indexed-access";
