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
  /** Morning leaders who are not on duty in the afternoon: they finish at midday. */
  leaving: readonly HutLeaderOnNight[];
  /** Afternoon leaders who were not on duty in the morning: they start at midday. */
  arriving: readonly HutLeaderOnNight[];
  /** Leaders on duty in both halves: nothing changes for them that day. */
  continuing: readonly HutLeaderOnNight[];
  /**
   * A HANDOVER: somebody finishes at midday and somebody is on duty from
   * midday. A day on which a second leader only JOINS a leader who stays on
   * is not one, so a one-night overlap (A's last night is B's first) is a
   * single handover, on the day A leaves, rather than two that each list A on
   * both sides.
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
  const morningIds = new Set(leadersOfPreviousNight.map((leader) => leader.memberId));
  const afternoonIds = new Set(leadersOfNight.map((leader) => leader.memberId));
  const leaving = leadersOfPreviousNight.filter((leader) => !afternoonIds.has(leader.memberId));
  return {
    morning: leadersOfPreviousNight,
    afternoon: leadersOfNight,
    changes,
    leaving,
    arriving: leadersOfNight.filter((leader) => !morningIds.has(leader.memberId)),
    continuing: leadersOfNight.filter((leader) => morningIds.has(leader.memberId)),
    isHandover: leaving.length > 0 && leadersOfNight.length > 0,
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

/**
 * One half's label in two parts: `text` carries the half and the names, so it
 * survives a narrow calendar cell; `suffix` is the wording a phone-width cell
 * drops. The full label is the two joined (`hutLeaderLineText`).
 */
export type HutLeaderLine = { text: string; suffix: string };

/** "AM · Smith until midday" — the morning half's label. */
export function hutLeaderMorningLine(names: string): HutLeaderLine {
  return { text: `AM · ${names}`, suffix: " until midday" };
}

/** "PM · Jones from midday" — the afternoon half's label. */
export function hutLeaderAfternoonLine(names: string): HutLeaderLine {
  return { text: `PM · ${names}`, suffix: " from midday" };
}

/** A line's full wording, as a screen reader hears it. */
export function hutLeaderLineText(line: HutLeaderLine | string): string {
  return typeof line === "string" ? line : `${line.text}${line.suffix}`;
}

/**
 * The label for a night with guests and no valid shift, in the club's own word
 * for the role ("No hut leader tonight", "No warden tonight"; #1320).
 */
export function noHutLeaderTonightLabel(hutLeaderLabel: string): string {
  return `No ${hutLeaderLabel.toLowerCase()} tonight`;
}
