"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { IntegrationWizard } from "@/components/admin/integration-wizard";
import type { WizardStepConfig } from "@/components/admin/integration-wizard";
import { useDisplayWizardContext } from "./use-display-wizard-context";
import {
  DISPLAY_WIZARD_ID,
  isBoardStepVerified,
  isBoardsStepVerified,
  isConfigStepVerified,
  isDoneStepVerified,
  isModuleStepVerified,
  isPairStepVerified,
  type DisplayWizardContext,
} from "./display-wizard-state";
import {
  BoardStep,
  BoardsStep,
  ConfigStep,
  DoneStep,
  ModuleStep,
  PairStep,
} from "./display-wizard-steps";

/**
 * The Lodge Display guided setup wizard (#2249) — a CONFIG of the reusable,
 * provider-agnostic `IntegrationWizard` shell (#2080), the same frame the Xero,
 * Stripe, Google and backup setups use. It supplies display-derived context and
 * six steps; the shell owns the stepper, gating, resume cursor and view-only
 * banner.
 *
 * Step order is the owner's signed-off order (29 Jul 2026): finish the
 * authoring, then hang the TV last.
 *
 * The wizard sits in the `lodge` area, which is what nearly everything it does
 * needs. The one exception is turning the module on (step 1), a `support` write
 * — that step gates its own control and says so.
 */
export function DisplaySetupWizard({
  moduleEnabled,
}: {
  /**
   * The `lobbyDisplay` flag, resolved in the page's SERVER render. It is passed
   * down rather than fetched because `/api/admin/modules` is support-gated and
   * a lodge-area admin must still be able to see (and be told about) the flag.
   */
  moduleEnabled: boolean;
}) {
  const { context, loading, refresh, selectLodge } =
    useDisplayWizardContext(moduleEnabled);
  const canEdit = useAdminAreaEditAccess("lodge");

  // The board picked on step 3. Held in memory ON PURPOSE: nothing server-side
  // records a "chosen" board before it is bound to a screen at pairing, and the
  // shell contract forbids verifying a step against anything but live server
  // truth. So this only pre-selects the binding on step 5 — step 3's own gate is
  // the real binding, which is why that step is skippable.
  const [chosenTemplateId, setChosenTemplateId] = useState<string | null>(null);

  const steps = useMemo<WizardStepConfig<DisplayWizardContext>[]>(
    () => [
      {
        id: "module",
        title: "Module",
        summary: "Turn the display on",
        isVerified: isModuleStepVerified,
        render: (ctx, helpers) => (
          <ModuleStep context={ctx} helpers={helpers} />
        ),
      },
      {
        id: "boards",
        title: "Built-in boards",
        summary: "Make sure boards exist",
        isVerified: isBoardsStepVerified,
        render: (ctx, helpers) => (
          <BoardsStep context={ctx} helpers={helpers} />
        ),
      },
      {
        id: "board",
        title: "Pick the board",
        summary: "Choose and preview",
        isVerified: isBoardStepVerified,
        optional: {
          skipLabel: "Decide at pairing",
          skipDescription:
            "Nothing records the choice until the screen is paired, so you can carry it forward and keep going.",
        },
        render: (ctx, helpers) => (
          <BoardStep
            context={ctx}
            helpers={helpers}
            chosenTemplateId={chosenTemplateId}
            onChoose={setChosenTemplateId}
            onSelectLodge={selectLodge}
          />
        ),
      },
      {
        id: "config",
        title: "Lodge details",
        summary: "Wi-Fi, checkout, notice",
        isVerified: isConfigStepVerified,
        optional: {
          skipLabel: "Fill these in later",
          skipDescription:
            "A club whose boards use no {{config:…}} tokens has nothing to fill in here.",
        },
        render: (ctx, helpers) => (
          <ConfigStep context={ctx} helpers={helpers} />
        ),
      },
      {
        id: "pair",
        title: "Pair the TV",
        summary: "Enter the code on screen",
        isVerified: isPairStepVerified,
        render: (ctx, helpers) => (
          <PairStep
            context={ctx}
            helpers={helpers}
            chosenTemplateId={chosenTemplateId}
            // The pick is component state, so a resume or a reload loses it.
            // The pairing step therefore has to be able to (re-)make it, rather
            // than pairing onto the club default in silence (#2249 review M3).
            onChoose={setChosenTemplateId}
          />
        ),
      },
      {
        id: "done",
        title: "Done",
        summary: "The screen has checked in",
        isVerified: isDoneStepVerified,
        render: (ctx, helpers) => <DoneStep context={ctx} helpers={helpers} />,
      },
    ],
    [chosenTemplateId, selectLodge],
  );

  const searchParams = useSearchParams();
  const initialStepId = searchParams.get("step") ?? undefined;

  return (
    <IntegrationWizard<DisplayWizardContext>
      wizardId={DISPLAY_WIZARD_ID}
      title="Lodge Display setup"
      description="A guided path from “the module is off” to a TV in the lodge showing the right board. Every step checks the real state of your club, so you can leave and come back — nothing here is a form you might lose."
      steps={steps}
      context={context}
      contextLoading={loading}
      onRefresh={refresh}
      canEdit={canEdit}
      initialStepId={initialStepId}
      completion={{
        badgeLabel: "Screen live",
        message: "Your lobby screen is live",
        hint: "Day-to-day changes live on Devices, the Visual builder and the lodge's display settings.",
      }}
      viewOnlyBanner={
        <>
          Your admin role can follow this setup, but restoring boards, saving
          lodge details and pairing a screen all need lodge edit access. Turning
          the module on additionally needs system-settings (support) edit
          access.
        </>
      }
    />
  );
}
