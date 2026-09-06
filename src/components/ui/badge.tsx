import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow hover:shadow-md",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:shadow-md",
        destructive:
          "border-transparent bg-danger text-danger-foreground shadow hover:shadow-md",
        outline: "text-foreground",
        success:
          "border-transparent bg-success-muted text-success shadow hover:shadow-md",
        warning:
          "border-transparent bg-warning-muted text-warning shadow hover:shadow-md",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

/**
 * The badge's variant keys, derived from the `cva` map above so a view model
 * that names a tone cannot drift from what `<Badge>` accepts (#3264). Import
 * it type-only from `src/lib` — the type is erased, so it adds no runtime edge.
 */
export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
