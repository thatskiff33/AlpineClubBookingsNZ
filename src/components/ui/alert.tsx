import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  type LucideIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"

// Shared status-banner primitive (#1802). Reads only from the semantic status
// tokens #1801 exposed to Tailwind (`--success`/`--warning`/`--destructive` and
// the `--info` trio added alongside them) — never a raw Tailwind colour palette.
// Every variant pairs an icon WITH text so colour is never the sole signal.
const alertVariants = cva(
  "flex items-start gap-3 rounded-md border px-4 py-3 text-sm",
  {
    variants: {
      variant: {
        info: "border-info/30 bg-info-muted text-info",
        success: "border-success/30 bg-success-muted text-success",
        warning: "border-warning/30 bg-warning-muted text-warning",
        error: "border-destructive/20 bg-destructive/10 text-destructive",
      },
    },
    defaultVariants: {
      variant: "info",
    },
  }
)

type AlertVariant = NonNullable<VariantProps<typeof alertVariants>["variant"]>

const variantIcon: Record<AlertVariant, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
}

// info/success are advisory (`role="status"`); warning/error are assertive
// (`role="alert"`). A caller-supplied `role` always wins — the admin members
// error banner passes `role="alert"` explicitly and is programmatically
// focused/scrolled to, so the role must remain overridable.
const assertiveVariants = new Set<AlertVariant>(["warning", "error"])

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, role, children, ...props }, ref) => {
    const resolvedVariant: AlertVariant = variant ?? "info"
    const Icon = variantIcon[resolvedVariant]
    const defaultRole = assertiveVariants.has(resolvedVariant) ? "alert" : "status"
    return (
      <div
        ref={ref}
        role={role ?? defaultRole}
        className={cn(alertVariants({ variant }), className)}
        {...props}
      >
        <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    )
  }
)
Alert.displayName = "Alert"

export { Alert, alertVariants }
