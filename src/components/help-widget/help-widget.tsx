"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { CircleHelp, Maximize2, X } from "lucide-react";
import { usePathname } from "next/navigation";
import {
  type HelpQuestion,
  type HelpSection,
} from "@/lib/contextual-help/types";
import type { HelpPageContent } from "@/lib/help/types";
import { HelpBrowseView } from "./help-browse-view";
import { HelpChatThread } from "./help-chat-thread";
import { HelpFreeTextInput } from "./help-free-text-input";
import { serializePageContext } from "./help-page-context";
import {
  useDiagnosticsRecord,
  useDiagnosticsViewState,
  useHelpWidgetState,
  usePublishDiagnosticsAvailable,
} from "./help-widget-context";
import {
  clampHelpPanelSize,
  DEFAULT_HELP_PANEL_SIZE,
  HELP_PANEL_KEYBOARD_STEP_PX,
  HELP_PANEL_MIN_WIDTH_PX,
  HELP_PANEL_SIZE_CLASSES,
  HELP_PANEL_SIZE_LABELS,
  helpPanelMaxWidthPx,
  nextHelpPanelSize,
  readStoredHelpPanelSize,
  storeHelpPanelSize,
  type HelpPanelSizeChoice,
} from "./help-widget-size";
import { useHelpChat, type HelpChatSurface } from "./use-help-chat";
import { DiagnosticsView } from "./diagnostics-view";
import { useDiagnosticsChat } from "./use-diagnostics-chat";

const GREETING = "Kia ora — need a hand with this page?";
const MAX_CHIPS = 8;

/** The panel's tabs. `diagnostics` renders only when the surface supplies it. */
type HelpPanelTab = "ask" | "guide" | "diagnostics";

export type HelpWidgetSurface = "public" | "member" | "admin" | "finance";

export type HelpWidgetProps = {
  surface: HelpWidgetSurface;
  llmEnabled: boolean;
  resolveHelp: (pathname: string) => HelpPageContent;
  position?: "app" | "website";
  /**
   * Typed free-text fetch target. Undefined in this PR (epic #2094 C2) — the
   * free-text input never renders and no fetch is reachable while llmEnabled is
   * false. C4 supplies it and flips llmEnabled.
   */
  chatEndpoint?: string;
  /**
   * AI Diagnostics (AID-7, #2378). PRESENT means this operator may ask diagnostics
   * questions from the bubble; absent means the tab does not exist for them.
   *
   * ITS PRESENCE IS THE PERMISSION, decided on the server. Owner decision Q6 is that
   * any admitted administrator may open the Diagnostics shell and that the shell must
   * NOT itself become a `support:view` permission — per-tool area gating happens at
   * invocation, freshly, on every call. So the admin layout passes this and the public,
   * member and lodge surfaces cannot: there is no client-side check here to get wrong,
   * and no prop a non-admin surface could set.
   *
   * `moduleEnabled` is the club's aiDiagnostics switch, so the tab can say "switched
   * off" instead of offering a box whose every question would be refused.
   */
  diagnostics?: { moduleEnabled: boolean };
};

/**
 * Hide the launcher while the analytics cookie banner occupies the same bottom
 * corner (website surface only). `AnalyticsConsent` stamps
 * `data-analytics-consent-banner="visible"` on the document element and fires an
 * `analytics-consent-visibility` event, so this is a deterministic, reactive
 * read of the same signal the banner drives — no duplicated storage logic.
 */
function useConsentBannerVisible(active: boolean): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const read = () =>
      document.documentElement.getAttribute("data-analytics-consent-banner") ===
      "visible";
    setVisible(read());
    const onVisibility = (event: Event) => {
      const detail = (event as CustomEvent<{ visible?: boolean }>).detail;
      setVisible(detail?.visible ?? read());
    };
    window.addEventListener("analytics-consent-visibility", onVisibility);
    return () =>
      window.removeEventListener("analytics-consent-visibility", onVisibility);
  }, [active]);

  return active && visible;
}

function orderChips(
  questions: HelpQuestion[],
  hintGroup: string | null,
): HelpQuestion[] {
  const ordered = hintGroup
    ? [...questions].sort(
        (a, b) =>
          Number(b.group === hintGroup) - Number(a.group === hintGroup),
      )
    : questions;
  return ordered.slice(0, MAX_CHIPS);
}

export function HelpWidget({
  surface,
  llmEnabled,
  resolveHelp,
  position = "app",
  chatEndpoint,
  diagnostics,
}: HelpWidgetProps) {
  const pathname = usePathname() ?? "/";
  const content = resolveHelp(pathname);
  const { extras, hintGroup } = useHelpWidgetState();
  const { record: diagnosticsRecord, clear: clearDiagnosticsRecord } =
    useDiagnosticsRecord();
  const diagnosticsViewState = useDiagnosticsViewState();
  /**
   * Tell the rest of the admin tree whether a row control should exist at all
   * (#2378 D11). Both halves of the answer live in the `diagnostics` prop: its
   * PRESENCE is the operator's permission, and `moduleEnabled` is the module flag.
   */
  usePublishDiagnosticsAvailable(Boolean(diagnostics?.moduleEnabled));
  const chat = useHelpChat({ llmEnabled, chatEndpoint });
  /**
   * Called unconditionally — hooks must be — but inert until the Diagnostics tab is
   * rendered: it holds empty state, starts no timer while nothing is pending, and its
   * only fetch is behind a submit the tab has to be open to reach.
   *
   * The two conversations are deliberately SEPARATE objects. Diagnostics is its own
   * product sharing this doorway (#2378), and one shared transcript would send page-
   * help turns to the diagnostics model and diagnostics answers — which carry evidence
   * about real people — to the page-help endpoint.
   */
  const diagnosticsChat = useDiagnosticsChat();

  const [open, setOpen] = useState(false);
  /**
   * Panel size (#2378 D8). Starts at the DEFAULT rather than the stored value and
   * is corrected after mount: reading `localStorage` during render would differ
   * between server and client and hydrate mismatched.
   */
  const [panelChoice, setPanelChoice] = useState<HelpPanelSizeChoice>({
    kind: "preset",
    size: DEFAULT_HELP_PANEL_SIZE,
  });
  useEffect(() => {
    setPanelChoice(readStoredHelpPanelSize());
  }, []);

  const commitChoice = useCallback((choice: HelpPanelSizeChoice) => {
    setPanelChoice(choice);
    storeHelpPanelSize(choice);
  }, []);

  /** The preset cycle. A dragged panel steps back onto the ladder at its next rung. */
  const cyclePanelSize = useCallback(() => {
    setPanelChoice((current) => {
      const from =
        current.kind === "preset" ? current.size : DEFAULT_HELP_PANEL_SIZE;
      const next: HelpPanelSizeChoice = {
        kind: "preset",
        size: nextHelpPanelSize(from),
      };
      storeHelpPanelSize(next);
      return next;
    });
  }, []);

  const panelRef = useRef<HTMLDivElement | null>(null);

  /**
   * Resize by a delta, from wherever the panel currently is.
   *
   * Measured from the LIVE element rather than from stored state, so the first drag
   * of a preset-sized panel starts from the size actually on screen instead of
   * jumping to a remembered number.
   */
  const resizeBy = useCallback(
    (deltaWidth: number, deltaHeight: number) => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      commitChoice(
        clampHelpPanelSize(
          {
            widthPx: rect.width + deltaWidth,
            heightPx: rect.height + deltaHeight,
          },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    },
    [commitChoice],
  );

  /**
   * Pointer drag on the corner handle.
   *
   * The panel is anchored bottom-right, so dragging the top-left corner LEFT and UP
   * makes it bigger — hence the negated deltas. Pointer capture is what makes the
   * drag survive the cursor leaving the handle, which it does immediately.
   */
  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Only a primary-button drag. A right-click or a two-finger gesture should not
      // start a resize the operator cannot see the end of.
      if (event.button !== 0) return;
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = rect.width;
      const startHeight = rect.height;
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();

      const move = (moveEvent: PointerEvent) => {
        commitChoice(
          clampHelpPanelSize(
            {
              widthPx: startWidth - (moveEvent.clientX - startX),
              heightPx: startHeight - (moveEvent.clientY - startY),
            },
            { width: window.innerWidth, height: window.innerHeight },
          ),
        );
      };
      const end = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    },
    [commitChoice],
  );

  /** Arrow keys on the same handle, so the gesture is not mouse-only. */
  const handleResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step = HELP_PANEL_KEYBOARD_STEP_PX;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [step, 0],
        ArrowRight: [-step, 0],
        ArrowUp: [0, step],
        ArrowDown: [0, -step],
      };
      const move = moves[event.key];
      if (!move) return;
      event.preventDefault();
      event.stopPropagation();
      resizeBy(move[0], move[1]);
    },
    [resizeBy],
  );

  const [tab, setTab] = useState<HelpPanelTab>("ask");
  const [viewportOffset, setViewportOffset] = useState(0);
  /**
   * Live viewport width, so a DRAGGED size applies only above the `sm:` breakpoint
   * (640px) where the panel floats. Below it the panel is a bottom sheet and a pixel
   * width would fight the layout rather than help it. Starts wide so the first
   * server render matches the desktop default and does not hydrate mismatched.
   */
  const [viewportWidth, setViewportWidth] = useState(1024);
  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const wasOpen = useRef(false);
  const headingId = useId();

  const currentPresetSize =
    panelChoice.kind === "preset" ? panelChoice.size : DEFAULT_HELP_PANEL_SIZE;
  const panelSizeClasses =
    panelChoice.kind === "preset"
      ? HELP_PANEL_SIZE_CLASSES[panelChoice.size]
      : "";
  /**
   * The corner anchors are DROPPED for the `full` preset rather than fought with.
   * Its `sm:inset-4` is the shorthand and these are the longhands; Tailwind emits
   * longhands after shorthands, so with both present the panel stays pinned at
   * `bottom-20 right-6` and "Full screen" only ever applies its top edge
   * (correctness review, 13 Aug 2026). Omitting the anchors when the preset owns
   * all four sides is deterministic where out-emitting the shorthand is not.
   */
  const panelAnchorClasses =
    panelChoice.kind === "preset" && panelChoice.size === "full"
      ? ""
      : "sm:inset-x-auto sm:bottom-20 sm:right-6";
  /**
   * A dragged size is inline, and only above the `sm:` breakpoint — below it the
   * panel is a bottom sheet and a pixel width would fight the layout rather than
   * help it. `sm:` is 640px, checked against the live viewport rather than a media
   * query object so it re-evaluates on resize with everything else.
   */
  const panelSizeStyle =
    panelChoice.kind === "custom" && viewportWidth >= 640
      ? { width: panelChoice.widthPx, height: panelChoice.heightPx }
      : undefined;

  /**
   * The width the resize handle reports (#4466). A focusable `separator` is a
   * value-bearing widget, so ARIA requires `aria-valuenow`; the handle grows the
   * panel's width (and height) and reports the width, measured from the panel as
   * rendered so a preset size reports what is on screen. Clamped into the same
   * min/max a drag is clamped to, so the value never leaves its stated range.
   */
  const [measuredPanelWidthPx, setMeasuredPanelWidthPx] = useState(0);
  useLayoutEffect(() => {
    const width = panelRef.current?.getBoundingClientRect().width;
    if (width !== undefined) setMeasuredPanelWidthPx(Math.round(width));
  }, [open, panelChoice, viewportWidth]);
  const resizeMaxWidthPx = helpPanelMaxWidthPx(viewportWidth);
  const resizeValueNow = Math.min(
    Math.max(measuredPanelWidthPx, HELP_PANEL_MIN_WIDTH_PX),
    resizeMaxWidthPx,
  );

  const consentBannerVisible = useConsentBannerVisible(surface === "public");

  // Route change: reset to the chip (Ask) view, but keep the transcript.
  //
  // DIAGNOSTICS IS EXEMPT, and that is the point of putting it in the bubble (owner
  // decision D8): the operator asks from "whichever admin screen they are looking
  // at", so navigating to the booking they are asking about must not close the
  // investigation they are in the middle of. The Page guide is page-specific and
  // genuinely is stale after a navigation, so it still falls back to Ask.
  useEffect(() => {
    setTab((current) => (current === "diagnostics" ? current : "ask"));
  }, [pathname]);

  /**
   * A chosen record does NOT follow the operator to another screen (#2378 D11).
   *
   * The conversation deliberately survives a navigation; the subject deliberately
   * does not, and the asymmetry is the honest one. The record was chosen from a row
   * on a particular list, and the server derives the record's KIND from whatever
   * route the operator is on now — so carrying a booking id onto `/admin/payments`
   * could only ever ask about a payment that does not exist. Dropping it means the
   * next question is about the screen in front of them, which is what the answer
   * would have said anyway.
   */
  useEffect(() => {
    clearDiagnosticsRecord();
  }, [pathname, clearDiagnosticsRecord]);

  /**
   * Choosing a record opens the panel on Diagnostics. Keyed on the NONCE, not the id:
   * choosing the same row again after closing the panel has to reopen it, and an
   * id-keyed effect would not re-run.
   */
  useEffect(() => {
    if (!diagnosticsRecord || !diagnostics?.moduleEnabled) return;
    setOpen(true);
    setTab("diagnostics");
    // The id is deliberately not a dependency — see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagnosticsRecord?.nonce, diagnostics?.moduleEnabled]);

  // Focus moves into the panel on open and returns to the launcher on close.
  useEffect(() => {
    if (open && !wasOpen.current) {
      headingRef.current?.focus();
    } else if (!open && wasOpen.current) {
      launcherRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  // iOS keyboard: lift the panel by the on-screen keyboard's height so a focused
  // control stays visible. The free-text input ships in C4; the mechanism is
  // wired now (guarded on visualViewport support).
  useEffect(() => {
    if (!open || typeof window === "undefined" || !window.visualViewport) {
      setViewportOffset(0);
      return;
    }
    const viewport = window.visualViewport;
    const update = () => {
      const offset = Math.max(
        0,
        window.innerHeight - viewport.height - viewport.offsetTop,
      );
      setViewportOffset(offset);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [open]);

  // Plain handlers — the React Compiler memoises these; a manual useCallback
  // trips its "could not be preserved" guard (house style, cf. ReportIssueWidget).
  const close = () => setOpen(false);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };

  // Keep a focused TEXT control centred above the keyboard (C4 input).
  //
  // TEXT-ENTRY CONTROLS ONLY, and the exclusion is load-bearing: a mouse click
  // focuses on mousedown, so centring the control HERE scrolls it out from under
  // the cursor before mouseup — the click then lands on whatever moved in, and a
  // checkbox never toggles. That is not a tail risk; it made the Diagnostics
  // consent ticks unclickable by mouse in every real browser (PR #2817's
  // Playwright run; jsdom stubs scrollIntoView, so the component tests saw
  // nothing). Text fields keep the behaviour because it exists for them — the
  // virtual keyboard covers a bottom-anchored input mid-typing — and a caret
  // lands on mousedown, so the moved click costs a text field nothing.
  const handleBodyFocus = (event: FocusEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (
      typeof target.matches === "function" &&
      target.matches(
        "textarea, input:not([type=checkbox]):not([type=radio]):not([type=button])",
      )
    ) {
      target.scrollIntoView?.({ block: "center" });
    }
  };

  const chips = orderChips(
    [...(extras.questions ?? []), ...(content.questions ?? [])],
    hintGroup,
  );
  const extraSections: HelpSection[] = extras.sections ?? [];
  const footerNote =
    surface === "public" ? "Members: sign in for more help." : undefined;

  // The paid AI free-text box renders only on an authenticated surface when the
  // LLM is available and a typed endpoint is supplied. The public surface never
  // reaches it (llmEnabled is a hardcoded false there).
  const showFreeText =
    llmEnabled && Boolean(chatEndpoint) && surface !== "public";

  // Plain handler — the React Compiler memoises it; a manual useCallback trips
  // its "could not be preserved" guard (house style).
  const handleSend = (text: string) => {
    void chat.sendFreeText(text, {
      pathname,
      surface: surface as HelpChatSurface,
      pageContext: serializePageContext(extras),
    });
  };

  const launcherWrapperClass =
    position === "website"
      ? "fixed bottom-6 right-5 z-50 sm:right-6 print:hidden"
      : "fixed bottom-20 left-5 z-50 sm:bottom-6 sm:right-6 sm:left-auto print:hidden";

  return (
    <>
      {consentBannerVisible ? null : (
        <div className={launcherWrapperClass} data-report-issue-ignore="true">
          <button
            ref={launcherRef}
            type="button"
            data-testid="help-widget-launcher"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-haspopup="dialog"
            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg transition-shadow hover:shadow-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <CircleHelp aria-hidden="true" className="h-4 w-4" />
            Help
          </button>
        </div>
      )}

      {open ? (
        <div
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          ref={panelRef}
          data-testid="help-widget-panel"
          data-report-issue-ignore="true"
          onKeyDown={handleKeyDown}
          style={{
            ...(viewportOffset > 0 ? { bottom: viewportOffset } : {}),
            ...(panelSizeStyle ?? {}),
          }}
          className={`fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-xl border border-border bg-card text-foreground shadow-lg sm:rounded-xl print:hidden ${panelAnchorClasses} ${panelSizeClasses}`}
        >
          {/* THE DRAG HANDLE the owner asked for (#2378 D8).
              The panel is anchored bottom-right, so its TOP-LEFT corner is the one
              that grows it — drag left and up for bigger.

              It is not pointer-only. `role="separator"` with a tabindex makes it a
              real stop in the tab order, and the arrow keys resize in steps, so the
              same gesture is available without a mouse. The preset button in the
              header remains for "just make it big" in one press.

              Hidden below `sm:` because the panel is a bottom sheet there, where a
              corner grip would fight the layout instead of helping. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize help panel. Use the arrow keys, or drag."
            aria-valuemin={HELP_PANEL_MIN_WIDTH_PX}
            aria-valuemax={resizeMaxWidthPx}
            aria-valuenow={resizeValueNow}
            aria-valuetext={`${resizeValueNow} pixels wide`}
            tabIndex={0}
            data-testid="help-widget-resize-handle"
            onPointerDown={handleResizePointerDown}
            onKeyDown={handleResizeKeyDown}
            className="absolute left-0 top-0 hidden h-6 w-6 cursor-nwse-resize touch-none rounded-br-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:block"
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-1.5 top-1.5 h-2.5 w-2.5 border-l-2 border-t-2 border-muted-foreground/60"
            />
          </div>

          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2
              id={headingId}
              ref={headingRef}
              tabIndex={-1}
              className="text-sm font-semibold text-foreground focus:outline-none"
            >
              Help
            </h2>
            <div className="flex items-center">
              {/* KEYBOARD-OPERABLE, not a drag handle (#2378 D8). An ordinary
                  button: reachable by Tab, activated by Enter or Space, and its
                  label announces the size it will move TO so a screen-reader user
                  knows what pressing it does rather than only where it is now. */}
              <button
                type="button"
                onClick={cyclePanelSize}
                aria-label={`Resize help panel to ${HELP_PANEL_SIZE_LABELS[nextHelpPanelSize(currentPresetSize)].toLowerCase()}`}
                data-testid="help-widget-resize"
                data-panel-size={panelChoice.kind === "preset" ? panelChoice.size : "custom"}
                className="hidden h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex"
              >
                <Maximize2 aria-hidden="true" className="h-4 w-4" />
              </button>
            <button
              type="button"
              onClick={close}
              aria-label="Close help"
              className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
            </div>
          </header>

          <div className="flex gap-1 border-b border-border px-2 py-2">
            {(
              [
                ["ask", "Ask"],
                ["guide", "Page guide"],
                // Diagnostics is offered ONLY when the server-rendered surface supplied
                // the prop. There is no client-side permission test here to get wrong.
                ...(diagnostics
                  ? ([["diagnostics", "Diagnostics"]] as const)
                  : []),
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
                data-testid={`help-widget-tab-${value}`}
                className={`rounded-md px-3 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  tab === value
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Focusable so a keyboard user can scroll it (#4466, WCAG 2.1.1): the
              Page guide is plain text, and a scroll container with nothing to tab
              to inside it cannot otherwise be reached without a mouse. It stays a
              plain container (no landmark role) inside the labelled dialog. */}
          <div
            onFocusCapture={handleBodyFocus}
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scroll container with no focusable content is the exception the rule's own docs name (axe scrollable-region-focusable)
            tabIndex={0}
            className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {tab === "diagnostics" && diagnostics ? (
              <DiagnosticsView
                chat={diagnosticsChat}
                pathname={pathname}
                moduleEnabled={diagnostics.moduleEnabled}
                recordId={diagnosticsRecord?.id}
                publishedView={diagnosticsViewState ?? undefined}
              />
            ) : tab === "ask" ? (
              <div className="flex flex-col gap-4">
                <HelpChatThread
                  greeting={GREETING}
                  messages={chat.messages}
                  questions={chips}
                  onAsk={chat.askCurated}
                  footerNote={footerNote}
                  capReached={chat.capReached}
                  pending={chat.pending}
                />
                {showFreeText ? (
                  <HelpFreeTextInput
                    onSend={handleSend}
                    pending={chat.pending}
                    capReached={chat.capReached}
                    disabledReason={chat.disabledReason}
                    onReset={chat.reset}
                  />
                ) : null}
              </div>
            ) : (
              <HelpBrowseView content={content} extraSections={extraSections} />
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
