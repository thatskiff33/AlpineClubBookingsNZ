/**
 * The two halves of a hut-leader day, derived from the night cover (#3818).
 *
 * A hut leader's duty is one lodge night, midday D to midday D+1
 * (`INV-DATE-002`). So calendar day D has two halves, exactly as the chore
 * roster reads a guest's day (`INV-DATE-004`, `getGuestOperationalDayPresence`):
 *
 *   the MORNING of D belongs to the leader(s) of night D − 1 (until midday)
 *   the AFTERNOON of D belongs to the leader(s) of night D (from midday)
 *
 * Nothing here is stored and nothing here decides coverage. The nights come
 * from `hut-leader-night-cover.ts`, which already answered "who validly covers
 * night N"; this only lines two consecutive answers up, the way the roster
 * derives Arriving and Departing from booked nights. Pure and client-safe, so
 * the hut-leaders calendar and the admin dashboard read one derivation.
 */

/** A leader as the halves need one: a stable identity and a name to show. */
export type HutLeaderOnNight = { memberId: string; name: string };

export type HutLeaderDayHalves = {
  /** Leaders of night D − 1, on duty until midday on D. */
  morning: readonly HutLeaderOnNight[];
  /** Leaders of night D, on duty from midday on D. */
  afternoon: readonly HutLeaderOnNight[];
  /**
   * The two halves have different leaders, so the day is shown split. True
   * also when one half has nobody (a stint starting or ending that day).
   */
  changes: boolean;
  /**
   * A HANDOVER: someone hands over to someone else — both halves have a
   * leader, and they differ.
   */
  isHandover: boolean;
};

function sameLeaders(
  left: readonly HutLeaderOnNight[],
  right: readonly HutLeaderOnNight[],
): boolean {
  const leftIds = new Set(left.map((leader) => leader.memberId));
  const rightIds = new Set(right.map((leader) => leader.memberId));
  if (leftIds.size !== rightIds.size) return false;
  for (const id of leftIds) {
    if (!rightIds.has(id)) return false;
  }
  return true;
}

/** Line night D − 1's leaders up against night D's. */
export function deriveHutLeaderDayHalves(
  leadersOfPreviousNight: readonly HutLeaderOnNight[],
  leadersOfNight: readonly HutLeaderOnNight[],
): HutLeaderDayHalves {
  const changes = !sameLeaders(leadersOfPreviousNight, leadersOfNight);
  return {
    morning: leadersOfPreviousNight,
    afternoon: leadersOfNight,
    changes,
    isHandover:
      changes && leadersOfPreviousNight.length > 0 && leadersOfNight.length > 0,
  };
}

/** Names joined for one half, deduplicated by member, in first-seen order. */
export function joinHutLeaderNames(
  leaders: readonly HutLeaderOnNight[],
  shorten: (name: string) => string = (name) => name,
): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const leader of leaders) {
    if (seen.has(leader.memberId)) continue;
    seen.add(leader.memberId);
    names.push(shorten(leader.name));
  }
  return names.join(" / ");
}

/** "AM · Smith until midday" — the morning half's label. */
export function hutLeaderMorningLabel(names: string): string {
  return `AM · ${names} until midday`;
}

/** "PM · Jones from midday" — the afternoon half's label. */
export function hutLeaderAfternoonLabel(names: string): string {
  return `PM · ${names} from midday`;
}

/** The label for a night with guests and no valid shift. */
export const NO_HUT_LEADER_TONIGHT_LABEL = "No leader tonight";
