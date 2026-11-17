import * as React from "react"

import { cn } from "@/lib/utils"

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-xl border bg-card text-card-foreground shadow",
      className
    )}
    {...props}
  />
))
Card.displayName = "Card"

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-6", className)}
    {...props}
  />
))
CardHeader.displayName = "CardHeader"

/**
 * The level a card title may claim in the page's heading outline.
 *
 * There is deliberately **no default**. A card's correct level depends on the
 * page it sits on — a card that is a page's main section is not the same level
 * as a card nested inside another card's content — and a silently wrong level
 * is worse for a screen-reader user than no heading at all (#2796).
 *
 * `"none"` is a classification, not an omission: the call site has looked at
 * its page and decided this title is not part of the outline. It renders
 * exactly what an omitted prop renders. The census in
 * `__tests__/card-title-classification-census.test.ts` counts omissions, not
 * `"none"` (#4951).
 */
type CardTitleHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6 | "none"

type CardTitleProps = React.HTMLAttributes<HTMLDivElement> & {
  /**
   * Opt in to heading semantics at this exact level, so the title appears in a
   * screen reader's heading list and `getByRole("heading", …)` can find it.
   *
   * Pass `"none"` (or, on a call site the census still ratchets, omit it) and
   * `CardTitle` renders exactly what it always has: a plain `<div>` with no
   * `role`, no `aria-level`, and the same classes. That output is pinned by
   * `__tests__/card-title-heading.test.tsx`.
   *
   * **There is deliberately no default level, and how to choose one is not
   * repeated here.** The convention — why this is ARIA rather than a native
   * `<h2>`, how to pick the level from the page's outline, and why a global
   * default is the owner's decision rather than a developer's — lives in ONE
   * place: `docs/ARCHITECTURE.md` → "Card titles and heading semantics (#2796)".
   * Restating it beside the code is how the two drift apart.
   */
  headingLevel?: CardTitleHeadingLevel
}

const CardTitle = React.forwardRef<HTMLDivElement, CardTitleProps>(
  ({ className, headingLevel, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("font-semibold leading-none tracking-tight", className)}
      {...(headingLevel === undefined || headingLevel === "none"
        ? {}
        : { role: "heading", "aria-level": headingLevel })}
      {...props}
    />
  )
)
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-6 pt-0", className)}
    {...props}
  />
))
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
