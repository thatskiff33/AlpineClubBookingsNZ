/**
 * Reading a real INSTANT back out of an admin API payload (CT-4, #2870;
 * epic #2988).
 *
 * ## This file is now a RE-EXPORT, and that is the whole change (#3123)
 *
 * The decoders themselves moved to `@/lib/payload-instant` when the
 * environment-safety screens under `src/components/admin/**` needed the same
 * contract: a shared component tree must not import an admin-route-scoped
 * `_lib`, and this module's own docblock had already flagged the equivalent
 * duplication next door as deliberate and temporary. The seven admin call sites
 * that name this path keep naming it.
 *
 * ## The sibling of `calendar-day.ts`, and the distinction is the whole point
 *
 * `calendar-day.ts` next door decodes a `@db.Date` column — a lodge night, a
 * date of birth, a season edge — and takes NO ZONE, because a calendar day has
 * none. This decodes the other kind: a `createdAt`, a `paidAt`, an audit stamp,
 * a consent response. Those are moments, and a moment has no civil date until a
 * zone is chosen. That zone is the club's persisted one (`INV-CONFIG-002`),
 * which a browser receives as data through `ClubTimeProvider` — never the
 * viewer's clock and never `APP_TIME_ZONE`.
 *
 * Confusing the two is the defect this epic exists to close, and no runtime type
 * can tell them apart: both arrive as the same ISO string. So the choice of
 * module IS the classification, and a call site that picks the wrong one is
 * visible in its import line rather than buried in a formatter.
 *
 * Why both degrade instead of throwing, and when `requireInstant` is the right
 * choice instead, are stated once at `@/lib/payload-instant`.
 */

/*
  ONLY THE `date` SHAPE IS RE-EXPORTED, because only it has callers here. The
  raw-string-fallback `formatPayloadInstantDateTimeOrRaw` sibling is consumed
  from `@/lib/payload-instant` directly by `src/components/admin/**`, and a
  re-export nothing imports is dead code the `knip` gate would report. Add it
  here the day an admin route under this tree wants it.
*/
export { formatPayloadInstantDate } from "@/lib/payload-instant";
