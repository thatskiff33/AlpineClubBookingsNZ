import { render as rtlRender } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { ClubSeasonProvider } from "@/components/club-season-provider";
import { DEFAULT_FINANCIAL_YEAR_END_MONTH } from "@/lib/financial-year";

import { ClubTimeTestProvider } from "./club-time-render";

/**
 * `club-time-render`'s shell plus the club's financial year-end (#5259), for a
 * suite rendering an ADMIN screen that names or picks a season.
 *
 * A separate wrapper rather than a third provider in the shared one, for the
 * reason that file gives for `renderWithClubFormat`: production mounts
 * `ClubSeasonProvider` in the admin layout only, so a member-area suite
 * standing under it would go green while the screen throws for real.
 *
 * The default is the March year-end every running club has, so a suite that
 * does not pass one asserts today's behaviour. A suite that means to prove the
 * year-end is honoured passes one March would not produce, such as 6 or 12.
 */
export function ClubSeasonTestProvider({
  yearEndMonth = DEFAULT_FINANCIAL_YEAR_END_MONTH,
  children,
}: {
  yearEndMonth?: number;
  children: ReactNode;
}) {
  return (
    <ClubTimeTestProvider>
      <ClubSeasonProvider yearEndMonth={yearEndMonth}>
        {children}
      </ClubSeasonProvider>
    </ClubTimeTestProvider>
  );
}

export function render(
  ui: ReactElement,
  options?: Parameters<typeof rtlRender>[1] & { yearEndMonth?: number },
): ReturnType<typeof rtlRender> {
  const { yearEndMonth, ...rest } = options ?? {};
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <ClubSeasonTestProvider yearEndMonth={yearEndMonth}>
        {children}
      </ClubSeasonTestProvider>
    ),
    ...rest,
  });
}

export * from "./club-time-render";
