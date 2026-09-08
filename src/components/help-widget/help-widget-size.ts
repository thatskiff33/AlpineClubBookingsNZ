/**
 * HOW BIG THE HELP PANEL IS, AND WHO DECIDES (AID-7, #2378, owner decision D8).
 *
 * The panel has always been one fixed size: 24rem wide and 70vh tall on a desktop,
 * a near-full-height sheet on a phone. That is comfortable for a help answer and
 * genuinely tight for a Diagnostics one, which can carry several blocker codes plus
 * the evidence it read them from. Since the owner's decision put ALL asking in this
 * panel rather than on a page, the panel has to be able to grow.
 *
 * BOTH A DRAG HANDLE AND PRESETS, which is what the owner asked for and also what
 * the accessibility bar requires. Drag is the natural gesture for "a bit bigger than
 * that" and no preset ladder replaces it. But a drag handle ALONE is reachable only
 * with a mouse — no keyboard path, nothing for a screen reader to announce, and a
 * fine motor gesture where a key press would do — and #2378 requires keyboard-only
 * and screen-reader operation as first class. So there are two controls over one
 * piece of state: a preset cycle button, and a corner handle that drags freely and
 * ALSO responds to arrow keys.
 *
 * ONE PIECE OF STATE, TWO WAYS TO SET IT. A dragged size is remembered as exact
 * pixels; a preset is remembered by name. Storing them as one tagged union rather
 * than two fields means the panel can never be "custom AND tall" with a silent rule
 * about which wins.
 *
 * THE SIZES ARE CSS CLASSES, NOT NUMBERS, because Tailwind needs the class names to
 * exist in the source to emit them; a computed `sm:w-[${n}rem]` produces a class
 * that was never built and the panel silently keeps its old width.
 *
 * MOBILE IS DELIBERATELY UNCHANGED. The panel is already a bottom sheet at 85dvh
 * there, so "tall" and "full screen" have almost nothing left to give, and a
 * viewport-sized floating panel on a phone is just a page that cannot be scrolled
 * past. Every preset therefore differs only from the `sm:` breakpoint up.
 */

/** The sizes an operator can choose. Ordered smallest to largest. */
export const HELP_PANEL_SIZES = ["comfortable", "tall", "full"] as const;

export type HelpPanelSize = (typeof HELP_PANEL_SIZES)[number];

/** The size the panel opens at when the operator has never chosen one. */
export const DEFAULT_HELP_PANEL_SIZE: HelpPanelSize = "comfortable";

/** A size the operator dragged to, in pixels. Only meaningful at `sm:` and up. */
export interface HelpPanelCustomSize {
  kind: "custom";
  widthPx: number;
  heightPx: number;
}

/** A size the operator chose from the preset cycle. */
export interface HelpPanelPresetSize {
  kind: "preset";
  size: HelpPanelSize;
}

export type HelpPanelSizeChoice = HelpPanelPresetSize | HelpPanelCustomSize;

/**
 * Bounds for a dragged size.
 *
 * The minimum is not cosmetic: below roughly 20rem the question box, the send
 * control and a one-line evidence summary stop fitting side by side, so a panel
 * dragged smaller than this is not a smaller panel, it is a broken one. The maximum
 * is applied against the live viewport at drag time rather than stored, because a
 * size dragged on a large monitor must not strand the panel off-screen on a laptop.
 */
export const HELP_PANEL_MIN_WIDTH_PX = 320;
export const HELP_PANEL_MIN_HEIGHT_PX = 240;
/** Kept clear of the viewport edges so browser chrome never overlaps the panel. */
export const HELP_PANEL_VIEWPORT_MARGIN_PX = 24;

/** How far one arrow-key press resizes. Coarse enough to be useful, fine enough to aim. */
export const HELP_PANEL_KEYBOARD_STEP_PX = 32;

/** Clamp a dragged size to something usable in the viewport it is being shown in. */
export function clampHelpPanelSize(
  size: { widthPx: number; heightPx: number },
  viewport: { width: number; height: number },
): HelpPanelCustomSize {
  const maxWidth = Math.max(
    HELP_PANEL_MIN_WIDTH_PX,
    viewport.width - HELP_PANEL_VIEWPORT_MARGIN_PX * 2,
  );
  const maxHeight = Math.max(
    HELP_PANEL_MIN_HEIGHT_PX,
    viewport.height - HELP_PANEL_VIEWPORT_MARGIN_PX * 2,
  );
  return {
    kind: "custom",
    widthPx: Math.min(Math.max(size.widthPx, HELP_PANEL_MIN_WIDTH_PX), maxWidth),
    heightPx: Math.min(
      Math.max(size.heightPx, HELP_PANEL_MIN_HEIGHT_PX),
      maxHeight,
    ),
  };
}

/** Is this a stored choice the panel knows how to render? */
export function isHelpPanelSizeChoice(value: unknown): value is HelpPanelSizeChoice {
  if (typeof value !== "object" || value === null) return false;
  const choice = value as {
    kind?: unknown;
    size?: unknown;
    widthPx?: unknown;
    heightPx?: unknown;
  };
  if (choice.kind === "preset") return isHelpPanelSize(choice.size);
  if (choice.kind === "custom") {
    return (
      typeof choice.widthPx === "number" &&
      typeof choice.heightPx === "number" &&
      Number.isFinite(choice.widthPx) &&
      Number.isFinite(choice.heightPx) &&
      choice.widthPx > 0 &&
      choice.heightPx > 0
    );
  }
  return false;
}

/**
 * Where the choice is remembered.
 *
 * `localStorage`, so it survives a reload and follows the operator around the admin
 * panel. It is UI preference and nothing else — no answer, no question, no evidence
 * and no identifier is stored, which matters because this product reads personal
 * data and its transcript is deliberately memory-only.
 */
export const HELP_PANEL_SIZE_STORAGE_KEY = "tac.help-panel-size";

/** Operator-facing label for each size. Used on the control and announced. */
export const HELP_PANEL_SIZE_LABELS: Record<HelpPanelSize, string> = {
  comfortable: "Comfortable",
  tall: "Tall",
  full: "Full screen",
};

/**
 * The panel's geometry classes for each size.
 *
 * Only the `sm:` half varies — see the mobile note above. Written out in full rather
 * than composed, so every class name is literally present for Tailwind to find.
 */
export const HELP_PANEL_SIZE_CLASSES: Record<HelpPanelSize, string> = {
  comfortable: "sm:w-[24rem] sm:max-h-[70vh]",
  tall: "sm:w-[28rem] sm:max-h-[90vh]",
  // Full screen still leaves the viewport's own padding, so the panel never sits
  // flush against the edges where a browser's own chrome overlaps it.
  full: "sm:inset-4 sm:w-auto sm:max-h-none sm:h-auto",
};

/** Is this a size the panel knows how to render? */
export function isHelpPanelSize(value: unknown): value is HelpPanelSize {
  return (
    typeof value === "string" &&
    (HELP_PANEL_SIZES as readonly string[]).includes(value)
  );
}

/**
 * The next size in the cycle, so one control can step through all three.
 *
 * A cycle rather than three buttons: three buttons in a header that already holds a
 * title and a close button is clutter, and the operator's actual intent is "bigger"
 * — which one predictable key press satisfies. It WRAPS from full back to
 * comfortable so there is always a way back without hunting for a different control.
 */
export function nextHelpPanelSize(current: HelpPanelSize): HelpPanelSize {
  const index = HELP_PANEL_SIZES.indexOf(current);
  // (index + 1) % HELP_PANEL_SIZES.length is always in [0, length) for any
  // integer index — including indexOf's -1-not-found case, which wraps to 0
  // — so this lookup cannot actually miss; `?? current` just keeps the type
  // honest without inventing a size that isn't `current`.
  return HELP_PANEL_SIZES[(index + 1) % HELP_PANEL_SIZES.length] ?? current;
}

/**
 * Read the remembered size, falling back to the default.
 *
 * Never throws. `localStorage` throws in a sandboxed iframe and when a browser is
 * configured to block storage, and a help panel that cannot open because it could
 * not read a cosmetic preference would be a genuinely bad trade.
 */
export function readStoredHelpPanelSize(): HelpPanelSizeChoice {
  const fallback: HelpPanelSizeChoice = {
    kind: "preset",
    size: DEFAULT_HELP_PANEL_SIZE,
  };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(HELP_PANEL_SIZE_STORAGE_KEY);
    if (!raw) return fallback;
    // A bare preset name is accepted alongside the JSON shape — not because any
    // earlier build wrote one (this key is new in #2378; nothing ever did), but as
    // deliberate forward-compatibility: it keeps the stored value's simplest
    // spelling readable, so a future simplification of what gets written — or a
    // hand-edited value — degrades to the preset instead of to the fallback.
    if (isHelpPanelSize(raw)) return { kind: "preset", size: raw };
    const parsed: unknown = JSON.parse(raw);
    return isHelpPanelSizeChoice(parsed) ? parsed : fallback;
  } catch {
    // Unparseable, or storage blocked. Either way the panel opens at its default
    // rather than not opening.
    return fallback;
  }
}

/** Remember the size. Silent on failure, for the same reason as the read. */
export function storeHelpPanelSize(choice: HelpPanelSizeChoice): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      HELP_PANEL_SIZE_STORAGE_KEY,
      JSON.stringify(choice),
    );
  } catch {
    // Preference not remembered. The panel still works at the chosen size for
    // this session, which is the part that matters.
  }
}
