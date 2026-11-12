"use client";

import type { ReactNode } from "react";
import type { VariantProps } from "class-variance-authority";

import { Button, type buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;

type NotifyChoiceAction = {
  label: ReactNode;
  /** Defaults to "default". Kept per action: some screens make the action destructive. */
  variant?: ButtonVariant;
  onSelect: () => void;
};

/**
 * What the dialog offers. The two shapes are separate on purpose (#2259): with
 * the booking's "No emails" switch on, the single action must send NO
 * `notifyMember` value, not `false` — so "no choice offered" is its own variant
 * a caller cannot express by passing a boolean.
 */
type NotifyChoiceActions =
  | {
      kind: "choice";
      withoutEmail: NotifyChoiceAction;
      withEmail: NotifyChoiceAction;
    }
  | { kind: "single"; action: NotifyChoiceAction };

const NOTIFY_CHOICE_BACK_LABEL = "Go back";

/**
 * The one dialog every admin action shows when it asks whether to email the
 * member (#1705, #1780 and its children, #2259, #4966).
 *
 * Every button but the first carries out the action, and for most callers the
 * action cannot be undone from the admin (a cancelled booking, a refund, an
 * approved application). So the rule this component exists to hold: the last
 * step before an irreversible action always offers a labelled way back, in the
 * usual dismiss position — first in the footer, outlined, as `useConfirm` does.
 * "Go back" only closes the dialog; it fires no action and leaves the page's
 * state alone.
 *
 * `submitting` disables every button and blocks every route out of the dialog
 * (Go back, the X, Escape, an outside click) while a request runs.
 *
 * The open state stays with the caller, as does closing it on select: callers
 * close before dispatching so the dialog never sits over a finished action.
 */
export function NotifyChoiceDialog({
  open,
  onOpenChange,
  title,
  description,
  summary,
  notice,
  submitting = false,
  backLabel = NOTIFY_CHOICE_BACK_LABEL,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  /** Shown between the description and the buttons, e.g. the amount about to move. */
  summary?: ReactNode;
  /** Shown above the buttons, e.g. `BookingNoEmailsNotice`. */
  notice?: ReactNode;
  submitting?: boolean;
  backLabel?: string;
  actions: NotifyChoiceActions;
}) {
  const footerActions =
    actions.kind === "choice"
      ? [actions.withoutEmail, actions.withEmail]
      : [actions.action];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {summary}
        {notice}
        {/* Three nowrap buttons outgrow the dialog's 32rem on the longest
            labels, so the row wraps (gap, not space-x, spaces wrapped rows). */}
        <DialogFooter className="gap-2 sm:flex-wrap sm:gap-2 sm:space-x-0">
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {backLabel}
          </Button>
          {footerActions.map((action, index) => (
            <Button
              key={index}
              type="button"
              variant={action.variant ?? "default"}
              disabled={submitting}
              onClick={action.onSelect}
            >
              {action.label}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
