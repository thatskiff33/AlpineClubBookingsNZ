"use client";

import { Label } from "@/components/ui/label";
import type { GuestsCardOtherLodge } from "@/components/edit-booking/edit-guests-card";

/**
 * The "Member of Other Lodge" header control on the edit-booking Guests card
 * (Other Lodges epic, follow-up to #2749): the switch, the partner-lodge picker,
 * and the two sentences that explain what ticking somebody does and why some
 * people have no tick box.
 *
 * ITS OWN FILE, not because the card could not hold it, but because the card
 * had reached its size budget and this is the coherent piece to lift out: it
 * owns one control and reads none of the guest rows. The per-row tick boxes stay
 * where they are, in `ExistingGuestRow`, since they belong to the row.
 *
 * ADMIN-ONLY BY ABSENCE, not by a disabled control — `available` is the presence
 * of the server's partner-lodge registry, which a member's payload does not
 * carry. A member therefore sees the card exactly as it was before this feature.
 */
export function OtherLodgeRateControl({
  otherLodge,
}: {
  otherLodge: GuestsCardOtherLodge;
}) {
  return (
    <div className="space-y-3 rounded-md border p-3 text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={otherLodge.enabled}
          onChange={(e) => otherLodge.onEnabledChange(e.target.checked)}
          className="h-4 w-4"
        />
        <span className="font-medium">Member of Other Lodge</span>
      </label>
      {otherLodge.enabled ? (
        <div className="space-y-1">
          <Label htmlFor="other-lodge-name">Other Lodge Name</Label>
          <select
            id="other-lodge-name"
            value={otherLodge.lodgeId ?? ""}
            onChange={(e) => otherLodge.onLodgeIdChange(e.target.value || null)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
          >
            <option value="">Select a lodge</option>
            {otherLodge.lodges.map((lodge) => (
              <option key={lodge.id} value={lodge.id}>
                {lodge.name}
              </option>
            ))}
          </select>
          {/*
            #2978: worded by the RATE, not by "non-members", so it matches the
            rows that actually get a tick box. Somebody added with
            "+ Add Member Guest" can be on the non-member rate too, and the old
            sentence told the officer not to tick exactly the people the tick is
            now for.
          */}
          <p className="text-xs text-muted-foreground">
            Tick anybody below you currently charge the non-member rate who is a
            member of this lodge. Each one is re-priced at this club&apos;s
            member rate for their age group; unticking puts them back on the rate
            they were on. The price change is shown before you save.
          </p>
          {/*
            Owner decision, 21 Aug 2026: SAY why somebody has no tick box.
            Withholding it is deliberate, but on the screen it is an empty column
            — nothing at all for a screen reader, and nothing an officer can tell
            apart from a bug. This explains it; it does not offer a way round it,
            which the owner considered and rejected.

            `role="note"` rather than a bare paragraph so assistive tech
            announces it as commentary attached to the control, and it sits
            inside the picker block so it is read with the thing it is about.
          */}
          <p role="note" className="text-xs text-muted-foreground">
            No tick box appears beside a member whose subscription is unpaid —
            their lockout rate stands. Settle the subscription if the reciprocal
            rate should apply to them.
          </p>
        </div>
      ) : null}
    </div>
  );
}
