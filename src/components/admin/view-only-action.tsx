"use client";

import { useId, type ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import { cn } from "@/lib/utils";

/**
 * Props for a component whose gated controls are explained by an
 * {@link AdminViewOnlySectionBanner} that an ANCESTOR renders, rather than by
 * the component itself (#2168 owner decision: one banner per page on
 * `/admin/members/[id]`).
 *
 * This is the mirror of `FamilyGroupEditor`'s `renderViewOnlyBanner` prop
 * (#2160). There, a component owns a banner and a covering parent SUPPRESSES
 * it. Here, a component owns no banner and a covering parent VOUCHES that it
 * renders one above these controls, which lets them drop their own per-button
 * reason. Both default to the self-sufficient behaviour, so a component dropped
 * into a container no banner reaches — a dialog, a sheet, a new page — still
 * explains itself.
 *
 * The default is `false` and that is the whole safety property: the opt-out
 * cannot happen unless a parent asks for it AT the render site. A component
 * that grows a new gated control, or gets rendered somewhere new, keeps its
 * per-button reason until someone deliberately vouches for it.
 *
 * Consuming components must use it in exactly one shape —
 * `describeReason={!ancestorRendersViewOnlyBanner}` — and must not forward it
 * to a grandchild. Vouching parents must render an UNCONDITIONAL
 * {@link AdminViewOnlySectionBanner} in the same returned JSX tree as the
 * child, and must pass the literal `true`. All of that is enforced statically
 * by `__tests__/view-only-banner-contract.test.ts`; see that file for what each
 * rule closes off.
 *
 * ONE further channel exists, for the guided-setup wizard shell only (#2324).
 * `IntegrationWizard` renders each step through a `render(context, helpers)`
 * callback it invokes from its own file, so no JSX render site exists at which
 * it could pass this prop. It vouches on `WizardStepHelpers` instead — a
 * required literal `true` — and a provider config forwards that at the step's
 * render site. The contract test honours it ONLY inside a real
 * `WizardStepConfig.render`, and only while the shell provably sets the flag and
 * renders the banner in every branch. Steps consume it exactly as above, so
 * there is still no third spelling of `describeReason`.
 *
 * Scope matters: the banner an ancestor renders states ONE permission area. A
 * child gated on a DIFFERENT area must not take this prop from it — the banner
 * would not be describing that child's controls. `member-credit-card.tsx` is
 * gated on `finance` while the member detail page banner states `membership`,
 * which is why it keeps its per-button reason.
 */
export interface AncestorViewOnlyBannerProps {
  ancestorRendersViewOnlyBanner?: boolean;
}

interface ViewOnlyActionButtonProps extends ButtonProps {
  // Tri-state (#2065): `undefined` while the session is resolving. Neutral
  // treatment for that window = disabled WITHOUT the view-only reason, so an
  // edit-capable admin never flashes the reason and a view-only admin never
  // flashes an enabled control. The read-only reason is only exposed once we
  // know the admin is view-only (`canEdit === false`).
  canEdit: boolean | undefined;
  readOnlyReason?: string;
  /**
   * Whether THIS button explains its own view-only state (#2142 owner
   * decision). Default `true`: a `title`, an `aria-describedby`, and an sr-only
   * line carrying {@link readOnlyReason}.
   *
   * Since #2160 the DEFAULT is no longer the usual case — it is the fallback.
   * Most admin sections render an {@link AdminViewOnlySectionBanner} and pass
   * `describeReason={false}` here (237 of 313 call sites), and a further 27 pass
   * `describeReason={!ancestorRendersViewOnlyBanner}` because a VOUCHING PARENT
   * renders the banner instead — 22 vouched at a JSX render site (#2168) and 5
   * through the guided-setup shell's `WizardStepHelpers` channel (#2324), where
   * the shell calls each step from another file and no render site exists.
   * 264 opt-outs in total.
   * `view-only-banner-contract.test.ts` asserts every one of those figures, so
   * they are measured rather than counted by hand. The default survives in
   * three shapes:
   *
   *  - inside a dialog, sheet, popover, or dropdown menu, which is a separate
   *    accessibility container (focus trapped, page behind commonly inert), so
   *    a banner in the page body does not reach it;
   *  - in a leaf component with no section of its own, dropped by a parent into
   *    someone else's layout (the member detail header toolbar, the booking
   *    capacity/exclusive hold controls, the #2259 per-booking "No emails"
   *    switch, the #2262 cash-payment and manual-refund-task controls, the
   *    non-member contact form), where
   *    nothing local proves an ancestor renders a banner. (`docs/ARCHITECTURE.md`
   *    counts 36 controls here, but that bucket is the arithmetic remainder,
   *    not a pure shape: 3 of the 34 are the FIRST shape — dialog contents
   *    inside `page-content-panel.tsx` and `site-banners-panel.tsx`, which are
   *    themselves banner-bearing panels; and 9 are the #2324 SCOPE exceptions
   *    below, sitting inside setup wizards that do render a banner); and
   *
   *  - in an integration setup wizard step whose control needs a NARROWER
   *    permission than the wizard's banner states (#2324): the Xero, Stripe,
   *    Google and backups credential-ish writes need Full Admin on top of the
   *    wizard's area, and the Lodge Display module switch is `support`-gated
   *    under a `lodge` banner. Their siblings gated on the wizard's OWN area do
   *    opt out, through the shell's vouch; and
   *  - in `member-credit-card.tsx` (4 controls), the one member detail card
   *    #2168 did NOT vouch for. Its siblings take the page banner's coverage;
   *    it cannot, because it is gated on `finance` while that banner states
   *    `membership`. Scope, not folder, is what decides.
   *
   * NEVER pass `false` without a banner in the SAME file. Doing so deletes the
   * explanation outright — no title, no description, no banner — which is
   * strictly worse than the per-button affordance it replaced. The ONE
   * sanctioned way to be covered from outside the file is
   * {@link AncestorViewOnlyBannerProps}, which replaces the missing local proof
   * with a checked one rather than dropping the requirement — either vouched at
   * a JSX render site (#2168) or, for a guided-setup wizard step the shell
   * renders through a callback, down `WizardStepHelpers` (#2324). Both
   * invariants —
   * and the fact that no THIRD spelling of `describeReason` is accepted — are
   * enforced by `__tests__/view-only-banner-contract.test.ts`.
   *
   * Pass `false` where the surrounding section already renders an
   * {@link AdminViewOnlySectionBanner}. A `disabled` button is out of the tab
   * order, so a keyboard user never lands on it and never meets the
   * `aria-describedby` reason in the normal flow — a screen-reader user CAN
   * still reach it in browse/virtual mode, so "unreachable" overstates it, but
   * only by going looking for a control they have already been given no reason
   * to expect. The `title` is worse than hard to reach: it never appears at all
   * here, because `buttonVariants` sets `disabled:pointer-events-none`
   * (`src/components/ui/button.tsx`), so a disabled `Button` receives no hover
   * event and the browser's native tooltip is never triggered. The banner says
   * it once, in the reading order, in a live region; repeating it per button
   * then only adds noise. Gating stays exactly the same either way: this prop
   * changes where the EXPLANATION lives, never whether the button is disabled.
   */
  describeReason?: boolean;
}

export function ViewOnlyActionButton({
  canEdit,
  readOnlyReason = ADMIN_VIEW_ONLY_ACTION_REASON,
  describeReason = true,
  disabled,
  title,
  "aria-describedby": ariaDescribedBy,
  children,
  ...props
}: ViewOnlyActionButtonProps) {
  const reasonId = useId();
  // Only a resolved view-only admin gets the read-only reason/affordance…
  const isReadOnly = canEdit === false;
  // …but the button stays disabled until we positively know editing is allowed,
  // so the resolving window (undefined) is a neutral disabled state.
  const isDisabled = canEdit !== true || disabled;
  // Opted out => the caller's own title/aria-describedby survive untouched.
  const annotate = isReadOnly && describeReason;
  // ADDED to, never replaced (#2282 review). A caller's `aria-describedby`
  // explains something ORTHOGONAL to permissions — on the member detail page,
  // why this particular member cannot take a dependent. When both apply
  // (a view-only admin looking at an archived member) replacing the caller's id
  // announced the permission reason and silently dropped the other, so the
  // admin heard only half of why the control is dead. `aria-describedby` takes
  // a space-separated id list precisely for this.
  const describedBy =
    [annotate ? reasonId : null, ariaDescribedBy].filter(Boolean).join(" ") ||
    undefined;

  return (
    <>
      <Button
        {...props}
        disabled={isDisabled}
        title={annotate ? readOnlyReason : title}
        aria-describedby={describedBy}
      >
        {children}
      </Button>
      {annotate ? (
        <span id={reasonId} className="sr-only">
          {readOnlyReason}
        </span>
      ) : null}
    </>
  );
}

/**
 * Message shown when a save is rejected with 403 — the defense-in-depth case
 * behind the UI gating (#1927): a stale tab that still shows live editors
 * because the actor's permissions were narrowed after the page loaded.
 */
export const ADMIN_FORBIDDEN_SAVE_REASON =
  "This change was not saved: your admin role can view this area but cannot make changes. Refresh the page to see the latest permissions.";

export function AdminForbiddenSaveNotice({
  className,
  children = ADMIN_FORBIDDEN_SAVE_REASON,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <p
      role="alert"
      className={cn(
        "rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11",
        className,
      )}
    >
      {children}
    </p>
  );
}

/**
 * Headline for the section-level view-only banner (#2142 owner decision).
 * Deliberately addressed to the person ("You have…") rather than to their role,
 * because it is read on arrival at the section, not hung off a control.
 */
export const ADMIN_VIEW_ONLY_SECTION_HEADING =
  "You have view-only access to this area";

/**
 * Section-level view-only banner (#2142 owner decision).
 *
 * The per-button affordance it replaces was, at best, hard to meet: a disabled
 * button is out of the tab order, so a keyboard user never lands on it and
 * never encounters the `aria-describedby` reason in the normal flow (a screen
 * reader can still traverse a disabled button in browse/virtual mode, but only
 * by going looking). The `title` was strictly worse — `buttonVariants` sets
 * `disabled:pointer-events-none`, so a disabled `Button` fires no hover event
 * and the native tooltip never appears at all. Saying it once at the top of the
 * section fixes both halves of that:
 *
 *  - it sits in the normal reading order, ahead of the controls it explains, so
 *    it is met before the dead buttons rather than after; and
 *  - `role="status"` (an implicit polite live region) announces it when its
 *    CONTENT appears, which is the real arrival moment here — `canEdit` is
 *    tri-state and resolves from `undefined` AFTER hydration.
 *
 * That second half is why the `role="status"` wrapper is rendered
 * UNCONDITIONALLY and only its content is gated. A polite live region has to be
 * registered in the accessibility tree BEFORE its content changes: a region
 * injected already-populated in a single mutation is announced by some
 * screen-reader/browser pairings and silently dropped by others (VoiceOver with
 * Safari notably). Adopting sections must therefore also mount this component
 * ABOVE their own loading early-return, so the region exists from the first
 * paint rather than from whenever the section's fetch settles. The empty
 * wrapper renders no visible box and takes no layout space — every style lives
 * on the inner element, which only exists once `canEdit === false`.
 *
 * Same tri-state contract as {@link AdminViewOnlyNotice}: the banner CONTENT
 * appears only once we positively know the admin is view-only, so it never
 * flashes while the session is still resolving. `canEdit` is required for the
 * same reason — a default would fire on an explicitly-passed `undefined`.
 *
 * Adopters pass the section-specific detail as `children`; the shared heading
 * is what makes it recognisable as the same banner from section to section.
 * `className` lands on the inner box (not the wrapper) so a spacing utility
 * applies only when there is something to space. Mount the wrapper OUTSIDE the
 * section's `space-y-*` stack: an empty wrapper is still a flex/stack child, so
 * left inside it would add a gap for every edit-capable admin.
 *
 * Since #2160 this is the default for the admin tree, not just Booking
 * Policies. {@link AdminViewOnlyNotice} is retained in three cases:
 *
 *  - surfaces that state view-only access WITHOUT gating a control through
 *    {@link ViewOnlyActionButton} — with no gated control there is nothing for
 *    this banner to head (seven files today);
 *  - a section whose Notice is CONDITIONAL on no ancestor covering it.
 *    `member-lodge-access-card`, `member-committee-assignments-card` and
 *    `member-seasonal-membership-card` each render their Notice only when
 *    `ancestorRendersViewOnlyBanner` is false (#2168), so the member detail page
 *    — which banners the whole page — sees no Notice, while the same card
 *    rendered anywhere else still states the reason itself. The lodge-access
 *    Notice also covers disabled CHECKBOXES that are not
 *    {@link ViewOnlyActionButton}s, which is why it is kept at all rather than
 *    deleted; and
 *  - a NARROWER permission scope nested inside a section this banner already
 *    heads. The banner states the section's own scope once at the top; a Notice
 *    further down carries a DIFFERENT permission's reason for a subset of the
 *    controls, so the two are not the same statement and the Notice is not
 *    redundant. `fees/_components/hut-fees-section.tsx` (finance inside a lodge
 *    section) and `subscription-lockout-settings-panel.tsx` (finance-scoped
 *    account/item codes inside a membership section) both do this deliberately,
 *    and both render banner AND Notice AND gated buttons.
 *
 * So "a section with gated controls replaces its Notice with this banner" holds
 * only for a Notice covering the SAME scope. Before deleting a Notice from a
 * section that has a banner, check which permission its text names — if it is
 * not the banner's, it is carrying a reason nothing else states.
 *
 * Known limitation (owner Decision 1 on #2160): the controls this banner
 * explains keep `disabled`, so they stay OUT of the keyboard tab order. The
 * banner puts the reason in the reading order ahead of them; it does not make
 * them focusable. Moving to `aria-disabled` would, but it turns every gated
 * control into a clickable one that must be neutralised, and the owner declined
 * that trade. Changing it back is a fresh decision, not a silent edit.
 */
export function AdminViewOnlySectionBanner({
  className,
  children,
  canEdit,
}: {
  className?: string;
  children?: ReactNode;
  canEdit: boolean | undefined;
}) {
  return (
    // The testid scopes a test's "the view-only banner" query away from the
    // section's OTHER live regions — `PolicyFeedback` renders a permanently
    // mounted `role="status"` for its success copy — the same way
    // `data-testid="booking-detail-content"` scopes content queries away from
    // the booking detail page's section rail. Counting `role="status"` nodes
    // globally would otherwise pin an unrelated component's a11y shape.
    <div role="status" data-testid="admin-view-only-banner">
      {canEdit === false ? (
        <div
          className={cn(
            "rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground",
            className,
          )}
        >
          <span className="font-medium">{ADMIN_VIEW_ONLY_SECTION_HEADING}.</span>
          {children ? <span> {children}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export function AdminViewOnlyNotice({
  className,
  children = ADMIN_VIEW_ONLY_ACTION_REASON,
  canEdit,
}: {
  className?: string;
  children?: ReactNode;
  /**
   * Tri-state edit access for the gated area (#2065). The banner renders only
   * once we positively know the admin is view-only (`canEdit === false`). While
   * the session is resolving (`undefined`) — or if the admin can edit
   * (`true`) — it renders nothing, so the "view only" banner never flashes
   * during the post-hydration session fetch. This prop is REQUIRED at every
   * call site: there is deliberately no default, because a default would fire
   * on an explicitly-passed `undefined` (the resolving state) and wrongly show
   * the banner. Panels whose edit flag is server/prop-computed pass that
   * boolean directly (it is never `undefined`).
   */
  canEdit: boolean | undefined;
}) {
  if (canEdit !== false) return null;

  return (
    <p
      className={cn(
        "rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}
