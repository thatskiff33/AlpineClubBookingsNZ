"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OTHER_LODGE_BOUNDS, type OtherLodgeReferences } from "@/lib/other-lodges";

/**
 * The lodge's name in the Other lodges editor (#64). Editable once the lodge
 * is keyed by the central server's id: the upload then sends that id, and the
 * server renames its lodge rather than creating a second one. Before that it
 * is read-only, and the route refuses a change too.
 */
export function OtherLodgeNameField({
  value,
  renamable,
  onChange,
}: {
  value: string;
  renamable: boolean;
  onChange: (name: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="other-lodge-name">Name</Label>
      <Input
        id="other-lodge-name"
        value={value}
        readOnly={!renamable}
        maxLength={OTHER_LODGE_BOUNDS.name}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby="other-lodge-name-note"
      />
      <p id="other-lodge-name-note" className="text-xs text-muted-foreground">
        {renamable
          ? "A new name is sent to the Alpine Central Server and reaches every other club on their next download."
          : "This lodge can be renamed after the next Download from the Alpine Central Server."}
      </p>
    </div>
  );
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * The note under a lodge the last whole-registry download did not match (#64):
 * usually a duplicate left by a rename before #64, or a lodge deleted there.
 * Says what still cites it, so an administrator can assess it; nothing removes
 * it here.
 */
export function NotOnCentralServerNote({ references }: { references: OtherLodgeReferences }) {
  const cited =
    references.bookings + references.bookingRequests === 0
      ? "Nothing here refers to it."
      : `Referred to by ${plural(references.bookings, "booking", "bookings")} and ${plural(
          references.bookingRequests,
          "booking request",
          "booking requests",
        )}.`;
  return (
    <div className="text-xs text-warning-11">
      Not found on the Alpine Central Server. {cited}
    </div>
  );
}
