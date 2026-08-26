import { describe, expect, it } from "vitest";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";
import { formatReferenceCacheLabel } from "../_components/shared";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";
import { chooseDivergentClubZone } from "@/lib/__tests__/helpers/club-time-zone";

/**
 * #2256 first fixed this label: it was built from bare `toLocaleString()` calls,
 * so the Xero account/item cache stamps rendered in the admin's own browser
 * locale and zone. CT-4 (#2870) finished the job — the zone is now the club's
 * PERSISTED `ClubTimeSettings.timeZone`, supplied by the caller's binding, and
 * not `APP_TIME_ZONE` (INV-CONFIG-002).
 *
 * ## Why the club zone is CHOSEN here rather than hard-coded
 *
 * A test under `Pacific/Auckland` CANNOT TELL THE TWO APART. That is the zone
 * `APP_TIME_ZONE` resolves to under test and the zone the old code used, so the
 * migrated code and the code it replaced return the identical string — "false
 * and green", the trap `CLUB_TIME_KERNEL.md` names. `America/Denver` escapes
 * that, which is why it was the house choice.
 *
 * But it escapes it BY COINCIDENCE. Run this suite with `TZ=America/Denver` and
 * the club zone and the environment become the same zone again — measured on
 * this branch, where that is exactly what happened. So the zone is now picked
 * from a table of candidates, each carrying its own hand-written expected label,
 * and `chooseDivergentClubZone` takes the first that disagrees with BOTH the
 * environment and UTC. On any ordinary host that is Denver and every literal
 * below is the one a reader can check by hand; on a Denver host it is
 * Kiritimati instead, and the suite stays discriminating rather than going
 * quietly green.
 *
 * UTC is a rival here and not merely the environment, because the assertion
 * pins the host to UTC on purpose: if the binding were ignored in favour of the
 * host clock, the hour would be 11:30 pm, and that has to be an answer no
 * candidate can accidentally produce.
 */
describe("formatReferenceCacheLabel (#2256, CT-4 #2870)", () => {
  // 2026-04-15T23:30:00Z is 16 Apr 11:30 am in Pacific/Auckland, 15 Apr 5:30 pm
  // in America/Denver, 16 Apr 1:30 pm in Pacific/Kiritimati and 15 Apr 11:30 pm
  // in UTC. Four different answers, which is what leaves room to choose.
  const CACHE = {
    source: "database" as const,
    lastRefreshedAt: "2026-04-15T23:30:00.000Z",
    expiresAt: "2026-04-16T11:30:00.000Z",
  };

  /**
   * Candidate club zones in preference order, each with the label it — and only
   * it — produces. Both are far from UTC in opposite directions, so whichever
   * the environment turns out to be, one of them still disagrees with it.
   */
  const CANDIDATES = [
    {
      zone: "America/Denver", // six hours behind UTC
      refreshed: "15 Apr 2026, 5:30 pm",
      answer: "15 Apr 2026, 5:30 pm | 16 Apr 2026, 5:30 am",
      label:
        "Accounts: shared cache, refreshed 15 Apr 2026, 5:30 pm, expires 16 Apr 2026, 5:30 am",
    },
    {
      zone: "Pacific/Kiritimati", // fourteen hours ahead of UTC
      refreshed: "16 Apr 2026, 1:30 pm",
      answer: "16 Apr 2026, 1:30 pm | 17 Apr 2026, 1:30 am",
      label:
        "Accounts: shared cache, refreshed 16 Apr 2026, 1:30 pm, expires 17 Apr 2026, 1:30 am",
    },
  ];

  /**
   * The whole label is what the assertion pins, so the whole label is what the
   * choice has to diverge on — a candidate agreeing with a rival on one of the
   * two stamps would leave half the assertion vacuous. Both stamps are joined
   * into one answer for exactly that reason, and each candidate carries that
   * joined pair as its `answer` so `answerKey` can check the fixture against
   * the zone it claims to describe.
   *
   * Deliberately an INDEPENDENT projection rather than `bindClubTime`, for two
   * reasons. It is an oracle: computing "what this zone would render" through
   * the very kernel under test would let a kernel-wide defect satisfy both
   * sides at once. And the rivals are not all club zones — the kernel refuses
   * `"UTC"` as a club timezone (`INV-CONFIG-002` bans a fixed offset), while a
   * runner with `TZ=UTC` makes `APP_TIME_ZONE` exactly that. `Intl` accepts
   * what the pre-CT-4 code accepted, which is the right admissibility rule for
   * a "what would the old code have produced" question.
   */
  const DATE_TIME_SHAPE: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  };
  const answerFor = (zone: string) => {
    const formatter = new Intl.DateTimeFormat(APP_LOCALE, {
      ...DATE_TIME_SHAPE,
      timeZone: zone,
    });
    return [CACHE.lastRefreshedAt, CACHE.expiresAt]
      .map((stamp) => formatter.format(new Date(stamp)))
      .join(" | ");
  };

  const chosen = chooseDivergentClubZone({
    subject: "the Xero reference-cache stamps",
    answerKey: "answer",
    cases: CANDIDATES,
    answerFor,
    // The host, which the assertion pins to UTC so a host read is visible.
    alsoDifferFrom: ["UTC"],
  });
  const clubTime = bindClubTime(requireClubTimeZone(chosen.zone));

  it("has a premise: the chosen club zone answers differently from the environment and from UTC", () => {
    // `chooseDivergentClubZone` already threw if this were false — it runs in
    // the describe body, where a failure cannot be skipped past. This states it
    // as a named test anyway, so a reader scanning the list can see the
    // assertion below is not vacuous without having to trust the helper.
    expect(answerFor(chosen.zone)).not.toBe(answerFor(APP_TIME_ZONE));
    expect(answerFor(chosen.zone)).not.toBe(answerFor("UTC"));
  });

  // The name says "not the host's" and stops there ON PURPOSE. This formatter
  // is handed a bound `clubTime` and has no path to `APP_TIME_ZONE` at all, so
  // "not APP_TIME_ZONE" would be unreachable-by-construction rather than
  // something this test excludes — a claim no mutation could ever falsify. What
  // the zone-authority premise above DOES establish is that the chosen zone
  // differs from `APP_TIME_ZONE`'s answer, which is what makes the binding
  // handed in meaningful; proving the plumbing that supplies it is the
  // provider suites' job, not this one's.
  it("renders both stamps in the club's persisted zone, not the host's", () => {
    // Pinned to UTC so the host is a third zone again: if the binding were
    // ignored in favour of the host, the refreshed stamp would read 11:30 pm.
    const label = withTimeZone("UTC", () =>
      formatReferenceCacheLabel(clubTime, "Accounts", CACHE),
    );
    expect(label).toBe(chosen.label);
  });

  it("still degrades to 'unknown' on an unparseable stamp instead of throwing", () => {
    const label = formatReferenceCacheLabel(clubTime, "Accounts", {
      ...CACHE,
      expiresAt: "not-a-date",
    });
    expect(label).toContain(`refreshed ${chosen.refreshed}`);
    expect(label).toContain("expires unknown");
  });

  it("treats an offset-less ISO stamp as unknown rather than reading it in the host's zone", () => {
    // Tightened by CT-4: `new Date("2026-04-16T11:30:00")` used to parse that
    // string as a wall-clock reading in whichever zone happened to be running,
    // which is the whole defect class this epic closes.
    const label = formatReferenceCacheLabel(clubTime, "Accounts", {
      ...CACHE,
      expiresAt: "2026-04-16T11:30:00",
    });
    expect(label).toContain("expires unknown");
  });

  it("keeps the no-metadata message", () => {
    expect(formatReferenceCacheLabel(clubTime, "Items", null)).toBe(
      "Items: no cache metadata yet",
    );
  });
});
