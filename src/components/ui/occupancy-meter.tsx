import { cn } from "@/lib/utils";

/**
 * OccupancyMeter — a bunks-filled bar (epic #1800, issue #1804).
 *
 * PRESENTATION ONLY: it renders the already-computed `filled` / `capacity`
 * counts; it does NOT compute occupancy, availability, or capacity. The fill uses
 * the brand accent (gold) and escalates to safety-orange (`--brand-safety`) when
 * the lodge is full (filled >= capacity). "Full" is signalled by an explicit
 * label and the aria-label — never colour alone — so it survives colour-blindness
 * and greyscale. The width uses a CSS transition, which the global
 * `prefers-reduced-motion` guard (#1801) collapses for users who opt out.
 */
export interface OccupancyMeterProps {
  /** Bunks already filled (already computed by the caller). */
  filled: number;
  /** Total bunk capacity (already computed by the caller). */
  capacity: number;
  /** Optional visible caption (e.g. a room name), folded into the aria-label. */
  label?: string;
  /** Bar thickness / text scale. Defaults to "md". */
  size?: "sm" | "md";
  className?: string;
}

const SIZE_STYLES = {
  sm: { track: "h-1.5", text: "text-xs" },
  md: { track: "h-2.5", text: "text-sm" },
} as const;

export function OccupancyMeter({
  filled,
  capacity,
  label,
  size = "md",
  className,
}: OccupancyMeterProps) {
  const safeCapacity = Math.max(0, Math.trunc(capacity));
  const safeFilled = Math.max(0, Math.trunc(filled));
  const isFull = safeCapacity > 0 && safeFilled >= safeCapacity;
  // Clamp the fill percentage and the aria value so an over-book (e.g. 31/30)
  // stays a valid progressbar while the visible count still shows the raw numbers.
  const pct = safeCapacity > 0 ? Math.min(100, (safeFilled / safeCapacity) * 100) : 0;
  const ariaValueNow = Math.min(safeFilled, safeCapacity);

  const countText = `${safeFilled} / ${safeCapacity}`;
  const ariaLabel = `${label ? `${label}: ` : ""}${safeFilled} of ${safeCapacity} bunks filled${
    isFull ? ", full" : ""
  }`;
  const sizes = SIZE_STYLES[size];

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {label ? (
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
      ) : null}
      <div className="flex items-center gap-2">
        <div
          role="progressbar"
          aria-valuenow={ariaValueNow}
          aria-valuemin={0}
          aria-valuemax={safeCapacity}
          aria-label={ariaLabel}
          className={cn(
            "relative w-full flex-1 overflow-hidden rounded-full bg-muted",
            sizes.track,
          )}
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500 ease-out",
              isFull ? "bg-brand-safety" : "bg-brand-gold",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span
          className={cn(
            "tabular-figures shrink-0 font-medium whitespace-nowrap",
            sizes.text,
            isFull ? "text-danger" : "text-foreground",
          )}
        >
          {countText}
          {isFull ? (
            <span className="ml-1 font-semibold uppercase tracking-wide">Full</span>
          ) : null}
        </span>
      </div>
    </div>
  );
}
