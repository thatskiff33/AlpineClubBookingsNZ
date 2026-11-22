import type { ComponentType } from "react";
import type { DisplayState } from "@/lib/lodge-display-state";
import type { DisplayModuleName } from "@/lib/lodge-display/template-registry";
import { getDisplayModule } from "@/lib/lodge-display/module-registry";
import type { DisplayPanelOptions } from "./module-options";
import { ArrivalsBoard } from "./arrivals-board";
import { ChoresBoard } from "./chores-board";
import { LodgeRules } from "./lodge-rules";
import { NightColumns } from "./night-columns";
import { NoticeBoard } from "./notice-board";
import { OccupancyGrid } from "./occupancy-grid";
import { RoomCards } from "./room-cards";
import { SinglesBoard } from "./singles-board";
import { StatusBoard } from "./status-board";
import { WelcomePanel } from "./welcome-panel";

// Module name -> renderer map for the lobby display (fork issue hoppers99/AlpineClubBookingsNZ#30). Every
// component is a pure function of the privacy-reduced DisplayState payload —
// none of them query anything (issue hoppers99/AlpineClubBookingsNZ#30 AC7). Names come from the closed
// registry in template-registry.ts; entries land as their issues deliver
// (LTV-006: chores/rules/text; LTV-007: header/footer; LTV-011: notice), and
// the display page renders a neutral placeholder for names without a
// component yet, so a template referencing a future module degrades safely.

export interface DisplayModuleProps {
  state: DisplayState;
  options?: DisplayPanelOptions;
}

/**
 * The graceful-degrade guarantee at the render boundary (LTV-026, ADR-003 §1).
 * A module whose metadata declares a HARD dependency (`dependencyMode: "hides"`)
 * renders nothing when the club flag it needs is off — the guard substitutes an
 * empty `data-module-disabled` placeholder so the rail keeps its shape without
 * an empty card. `"degrades"` modules are returned unwrapped: they render their
 * own reduced form (e.g. per-booking rows when bed allocation is off), so the
 * flag check would only suppress a form they already handle.
 *
 * Only `chores-board` is a `"hides"` module today; the wrapper is generic so a
 * future hard-dependency module is covered by declaring its metadata alone.
 */
export function withModuleGuard(
  name: DisplayModuleName,
  Component: ComponentType<DisplayModuleProps>
): ComponentType<DisplayModuleProps> {
  const metadata = getDisplayModule(name);
  if (
    !metadata ||
    metadata.dependencyMode !== "hides" ||
    metadata.dependencies.length === 0
  ) {
    return Component;
  }
  const dependencies = metadata.dependencies;
  function GuardedModule({ state, options }: DisplayModuleProps) {
    const unmet = dependencies.some((flag) => state.capabilities[flag] !== true);
    if (unmet) {
      return <div className="display-module-disabled" data-module-disabled={name} />;
    }
    return <Component state={state} options={options} />;
  }
  GuardedModule.displayName = `ModuleGuard(${name})`;
  return GuardedModule;
}

export const DISPLAY_MODULE_COMPONENTS: Partial<
  Record<DisplayModuleName, ComponentType<DisplayModuleProps>>
> = {
  "arrivals-board": withModuleGuard("arrivals-board", ArrivalsBoard),
  "occupancy-grid": withModuleGuard("occupancy-grid", OccupancyGrid),
  welcome: withModuleGuard("welcome", WelcomePanel),
  "singles-board": withModuleGuard("singles-board", SinglesBoard),
  "room-cards": withModuleGuard("room-cards", RoomCards),
  "night-columns": withModuleGuard("night-columns", NightColumns),
  "status-board": withModuleGuard("status-board", StatusBoard),
  "chores-board": withModuleGuard("chores-board", ChoresBoard),
  "lodge-rules": withModuleGuard("lodge-rules", LodgeRules),
  "notice-board": withModuleGuard("notice-board", NoticeBoard),
};
