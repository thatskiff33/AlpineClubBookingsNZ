"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

type RadioProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">

/**
 * The one radio dot (#4431, #4467). A raw `<input type="radio">` outside
 * `src/components/ui/` fails `design-system/no-raw-input`. Choice cards stay
 * buttons (`OptionCard`); this is the dot beside a label.
 *
 * The ring and the checked dot share one grid cell, the same way `Checkbox`
 * centres its tick. `className` lands on the outer box so a caller can align
 * it with wrapping label text (`mt-0.5`) without shifting the dot off the ring.
 */
const Radio = React.forwardRef<HTMLInputElement, RadioProps>(function Radio({
  className,
  ...props
}, ref) {
  return (
    <span className={cn("relative inline-grid size-4 shrink-0 place-items-center align-middle", className)}>
      <input
        {...props}
        ref={ref}
        type="radio"
        data-slot="radio"
        className="peer col-start-1 row-start-1 size-4 shrink-0 appearance-none rounded-full border border-input shadow-xs transition-shadow outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 checked:border-primary checked:bg-primary checked:text-primary-foreground dark:bg-input/30 dark:aria-invalid:ring-destructive/40 dark:checked:bg-primary"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none col-start-1 row-start-1 hidden size-1.5 rounded-full bg-primary-foreground peer-checked:block"
      />
    </span>
  )
})

export { Radio }
