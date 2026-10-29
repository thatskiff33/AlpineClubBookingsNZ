"use client"

import type { CSSProperties } from "react"
import { useTheme } from "next-themes"
import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

// #4466 — sonner's own `richColors` text inks are below WCAG 4.5:1 on their own
// tints (success hsl(140 100% 27%) on its green tint measured 4.25:1, and the
// warning amber and error red sit lower still). Its palette is a set of custom
// properties on the toaster element, so they are re-pointed here at the
// app's semantic status pairs on `:root` (`--success` on `--success-muted`, …),
// which clear AA and re-tint for dark mode (globals.css, #1801/#1804). The
// toaster mounts outside `app-theme-scope`, so it is these root pairs, not the
// club-generated step scales, that resolve here. An inline style is what
// outranks the stylesheet sonner injects at runtime.
const RICH_COLOR_TOKENS = {
  "--success-bg": "var(--success-muted)",
  "--success-text": "var(--success)",
  "--info-bg": "var(--info-muted)",
  "--info-text": "var(--info)",
  "--warning-bg": "var(--warning-muted)",
  "--warning-text": "var(--warning)",
  "--error-bg": "var(--danger-muted)",
  "--error-text": "var(--danger)",
} as CSSProperties

const Toaster = ({ style, ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      style={{ ...RICH_COLOR_TOKENS, ...style }}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
