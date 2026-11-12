"use client";

import { Laptop, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export const UI_THEME_STORAGE_KEY = "alpine-ui-theme";

const themeOptions = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "Follow system", icon: Laptop },
] as const;

type ThemeOption = (typeof themeOptions)[number]["value"];

function useActiveTheme(): {
  activeTheme: ThemeOption;
  setTheme: (value: string) => void;
} {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const activeTheme: ThemeOption =
    mounted && (theme === "light" || theme === "dark" || theme === "system")
      ? theme
      : "system";

  useEffect(() => {
    setMounted(true);
  }, []);

  return { activeTheme, setTheme };
}

interface ThemeSwitcherProps {
  className?: string;
  label?: string;
}

export function ThemeSwitcher({
  className,
  label = "Theme",
}: ThemeSwitcherProps) {
  const { activeTheme, setTheme } = useActiveTheme();

  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
      <div
        aria-label={label}
        className="grid grid-cols-3 gap-1 rounded-md border bg-muted p-1"
        role="radiogroup"
      >
        {themeOptions.map(({ value, label: optionLabel, icon: Icon }) => {
          const active = activeTheme === value;

          return (
            <button
              aria-checked={active}
              className={cn(
                "flex min-h-10 flex-col items-center justify-center gap-1 rounded px-2 py-1.5 text-center text-[11px] font-medium leading-tight text-foreground transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active && "bg-background text-foreground shadow-sm"
              )}
              key={value}
              onClick={() => setTheme(value)}
              role="radio"
              type="button"
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>{optionLabel}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Theme choices for a menu. A menu may contain menuitemradio, not a nested
 * radiogroup, so the desktop user menu uses this instead of {@link ThemeSwitcher}.
 */
export function ThemeMenuItems() {
  const { activeTheme, setTheme } = useActiveTheme();

  return (
    <DropdownMenuRadioGroup value={activeTheme} onValueChange={setTheme}>
      {themeOptions.map(({ value, label: optionLabel }) => (
        <DropdownMenuRadioItem key={value} value={value}>
          {optionLabel}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}
