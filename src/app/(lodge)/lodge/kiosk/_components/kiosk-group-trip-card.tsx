"use client";

import { ADULT_MEMBER_HOST_SCOPE_LABELS } from "@/lib/policies/adult-member-hosting";
import type {
  KioskAdultCoverSource,
  KioskGroupTripLabel,
  KioskGroupTripOrganiser,
} from "@/lib/kiosk-group-trip";

/**
 * The Group Trip block on one kiosk booking card (#3040, epic #2943).
 *
 * ## This component renders what it is given and nothing else
 *
 * The tier split happens on the SERVER, in `src/lib/kiosk-group-trip.ts`: a
 * viewer without a capability is not sent the field at all, so there is nothing
 * here for a mistake to reveal. That is deliberate and it is the design the
 * issue asked for — "send the full object and hide fields in JSX" was rejected
 * by name, because in a React application anything reachable from a component's
 * props is in the browser whether it is rendered or not.
 *
 * The consequence for anybody editing this file: **do not add a prop that
 * carries data an ordinary staying guest may not see.** The privacy guarantee
 * lives in the payload, and a new prop moves the boundary without touching the
 * module that documents it.
 *
 * ## No private data in an attribute, either
 *
 * There is deliberately no `title`, `aria-label` or `data-*` attribute carrying
 * a group id, an organiser name or a cover source anywhere below. A tooltip and
 * a screen-reader label are as readable as body text — more so, because nobody
 * looks at them in review — and the issue lists them among the leaks it forbids.
 * Every string rendered here is visible on screen.
 */

/** What an ordinary staying guest may see: the trip ordinal, and nothing more. */
export function KioskGroupTripBadge({
  groupTrip,
}: {
  groupTrip: KioskGroupTripLabel | undefined;
}) {
  if (!groupTrip) return null;
  return (
    <span className="rounded-lg bg-kiosk-chip px-3 py-1 text-sm font-medium text-kiosk-fg">
      Group trip {groupTrip.label}
    </span>
  );
}

/**
 * Capability 1's line: who organised the trip.
 *
 * `organiserName` is null when the container could not be read, and that says
 * so rather than guessing.
 */
export function KioskGroupTripOrganiserLine({
  organiser,
}: {
  organiser: KioskGroupTripOrganiser | undefined;
}) {
  if (!organiser) return null;
  const name = organiser.organiserName;
  return (
    <p className="mt-2 text-sm text-kiosk-muted-fg">
      {organiser.isOrganiser
        ? "Organises this Group Trip"
        : name === null
          ? "Group Trip organiser: not available"
          : `Group Trip organised by ${name}`}
    </p>
  );
}

/**
 * Capability 2's line: adult cover, exactly as the canonical rule last
 * evaluated it.
 *
 * FOUR STATUSES, AND ONLY ONE OF THEM MAY LOOK LIKE COVER. `nights` is empty
 * for the other three by construction (see `KioskCoverEvidenceStatus`), so this
 * component cannot render a positive claim off stale, failed or unrecorded
 * evaluation even if somebody rewrites the branches below.
 *
 * The counts are honest about PARTIAL nights: "2 of 3 nights" is the normal
 * shape of a real stay, because cover is decided per night and different nights
 * can be covered by different sources. The scope labels are the club-facing
 * strings the admin settings card already uses
 * (`ADULT_MEMBER_HOST_SCOPE_LABELS`), not a second set of words for the same
 * three categories.
 */
export function KioskAdultCoverSourceLine({
  cover,
}: {
  cover: KioskAdultCoverSource | undefined;
}) {
  if (!cover) return null;

  if (cover.status !== "EVALUATED") {
    const wording =
      cover.status === "STALE"
        ? "Adult cover: needs re-checking — the last check is out of date"
        : cover.status === "UNREADABLE"
          ? "Adult cover: last check could not be read"
          : "Adult cover: not recorded for this booking";
    return (
      <p className="mt-2 rounded-lg border border-kiosk-warning-border bg-kiosk-warning-bg px-3 py-1 text-sm text-kiosk-warning-fg">
        {wording}
      </p>
    );
  }

  if (cover.nights.length === 0) {
    return (
      <p className="mt-2 text-sm text-kiosk-muted-fg">
        Adult cover: no nights need an adult member on this booking
      </p>
    );
  }

  const covered = cover.nights.filter((night) => night.covered).length;
  const total = cover.nights.length;
  const allCovered = covered === total;

  return (
    <div className="mt-2 text-sm">
      <p
        className={
          allCovered ? "text-kiosk-success-fg" : "text-kiosk-danger-fg"
        }
      >
        Adult cover: {covered} of {total}{" "}
        {total === 1 ? "night" : "nights"} covered
      </p>
      {cover.scopes.length > 0 && (
        <p className="text-kiosk-muted-fg">
          {/* The SOURCE categories, never the person. Which adult, on whose
              account, is not a kiosk question. */}
          From: {cover.scopes.map((s) => ADULT_MEMBER_HOST_SCOPE_LABELS[s]).join("; ")}
        </p>
      )}
      {!allCovered && (
        <p className="text-kiosk-muted-fg">
          Not covered:{" "}
          {cover.nights
            .filter((night) => !night.covered)
            .map((night) => night.night)
            .join(", ")}
        </p>
      )}
    </div>
  );
}
