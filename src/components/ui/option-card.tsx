"use client";

import * as React from "react";
import { CheckCircle2, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/*
  #4563 — the one choice card: a set of mutually exclusive options, such as
  Card or Internet Banking, laid out as cards rather than radio dots.

  Before this, four screens drew their own and three of them showed the chosen
  card by colour alone: no `aria-pressed`, no visible word. A screen-reader user
  heard two identical buttons and could not tell which one was chosen, and so
  could anyone who cannot tell the info tint from the card surface (WCAG 1.4.1,
  4.1.2).

  The card carries both cues itself, so a caller cannot leave one out:
  - `aria-pressed` on a native `<button>`. Each card is a toggle button that
    reports whether it is on, and a native button takes Enter and Space and the
    tab order from the browser with no key handler here. The repo has no radio
    primitive, and the existing payment specs find these cards by the button
    role.
  - a visible "Selected" label with a check icon on the chosen card, so the
    choice is never carried by the tint alone.

  `OptionCardGroup` names the set: a `role="group"` labelled by its heading, so
  a screen reader announces "Payment method, group" before the cards.
*/

export type OptionCardProps = Omit<
  React.ComponentPropsWithoutRef<"button">,
  "type" | "title" | "aria-pressed" | "onClick" | "children"
> & {
  /** Whether this option is the chosen one. */
  selected: boolean;
  /** Called when the option is chosen (click, Enter or Space). */
  onSelect: () => void;
  /** A decorative icon; rendered `aria-hidden`. */
  icon?: LucideIcon;
  /** The option's name, read first in its accessible name. */
  title: React.ReactNode;
  /** One line or two of explanation under the title. */
  children?: React.ReactNode;
};

const OptionCard = React.forwardRef<HTMLButtonElement, OptionCardProps>(
  ({ selected, onSelect, icon: Icon, title, children, className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex min-h-16 items-start gap-3 rounded-md border p-3 text-left text-sm",
        selected
          ? "border-info bg-info-3 text-info-11 ring-1 ring-info"
          : "border-border bg-card text-card-foreground hover:border-foreground",
        className,
      )}
      {...props}
    >
      {Icon ? <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" /> : null}
      <span>
        <span className="block font-medium">{title}</span>
        {children ? <span className="block text-xs">{children}</span> : null}
        {selected ? (
          // Seen, not heard: `aria-pressed` already announces the state, and
          // keeping the word out of the name stops a change of choice
          // re-reading both cards' names (#4563 review).
          <span aria-hidden className="mt-1 inline-flex items-center gap-1 text-xs font-semibold">
            <CheckCircle2 aria-hidden className="h-3.5 w-3.5" />
            Selected
          </span>
        ) : null}
      </span>
    </button>
  ),
);
OptionCard.displayName = "OptionCard";

export type OptionCardGroupProps = Omit<React.ComponentPropsWithoutRef<"div">, "children"> & {
  /** The visible heading that names the set, such as "Payment method". */
  label: React.ReactNode;
  children: React.ReactNode;
};

function OptionCardGroup({ label, children, className, ...props }: OptionCardGroupProps) {
  const labelId = React.useId();
  return (
    <div className={cn("space-y-2", className)} {...props}>
      <p id={labelId} className="text-sm font-medium text-foreground">
        {label}
      </p>
      <div role="group" aria-labelledby={labelId} className="grid gap-2 sm:grid-cols-2">
        {children}
      </div>
    </div>
  );
}

export { OptionCard, OptionCardGroup };
