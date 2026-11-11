"use client"

import type { ReactNode } from "react"
import { ChevronDown } from "lucide-react"
import {
  AccordionContent,
  AccordionHeader,
  AccordionItem,
  AccordionPlainTrigger,
} from "@/components/ui/accordion"
import { cn } from "@/lib/utils"
import type { CollapsibleMemberSection } from "@/lib/admin-member-detail-helpers"

interface MemberGroupCardProps {
  id: CollapsibleMemberSection
  title: string
  preview?: ReactNode
  actions?: ReactNode
  className?: string
  contentClassName?: string
  children: ReactNode
}

export function MemberGroupCard({
  id,
  title,
  preview,
  actions,
  className,
  contentClassName,
  children,
}: MemberGroupCardProps) {
  return (
    <AccordionItem
      value={id}
      id={`member-group-${id}`}
      className={cn(
        "overflow-hidden rounded-xl border bg-card text-card-foreground shadow scroll-mt-20",
        className
      )}
    >
      {/* Header is composed from parts so `actions` can sit beside the
          trigger without nesting interactive elements inside the button. */}
      <AccordionHeader className="items-center gap-2 px-6">
        <AccordionPlainTrigger
          className={cn(
            "group flex flex-1 items-center justify-between gap-4 py-5",
            "text-left text-base font-medium hover:no-underline",
            "[&>svg]:transition-transform [&>svg]:duration-200 [&[data-state=open]>svg]:rotate-180"
          )}
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
            <span className="shrink-0">{title}</span>
            {preview ? (
              <span className="truncate text-sm font-normal text-muted-foreground group-data-[state=open]:hidden">
                {preview}
              </span>
            ) : null}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0" />
        </AccordionPlainTrigger>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </AccordionHeader>
      <AccordionContent className={cn("px-6 pb-6", contentClassName)}>
        {children}
      </AccordionContent>
    </AccordionItem>
  )
}
