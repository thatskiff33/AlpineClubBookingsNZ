/**
 * One season WINDOW as the Seasons page reads it from `/api/admin/seasons`:
 * name, type, dates and active state for one lodge (#1933, E7). Rates are not
 * part of it; they are edited in Fees → Hut Fees. The two edges are the API's
 * serialised `@db.Date` values, read through `readSeasonSchedule` and
 * `formatSeasonEdge` in `admin/_lib/season-schedule.ts`.
 */
export interface Season {
  id: string
  name: string
  type: "WINTER" | "SUMMER"
  startDate: string
  endDate: string
  active: boolean
}
