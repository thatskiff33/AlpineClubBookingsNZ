import type { DisplayState } from "@/lib/lodge-display-state";
import type { DisplayPanelOptions } from "./module-options";
import { shortDay } from "./status-helpers";

// The day's chore list (fork issue #31): renders DisplayState.chores exactly
// as the privacy serialiser provided them — assignee labels are already
// reduced (a minor's chore carries the family/group label, issue #28), and
// this module never re-derives names from any other source (issue #31 AC1).

function choreDayLabel(date: string, windowStart: string): string {
  if (date === windowStart) return "Today";
  // The one shared column-head shape (`status-helpers.shortDay`).
  return shortDay(date);
}

export function ChoresBoard({
  state,
}: {
  state: DisplayState;
  options?: DisplayPanelOptions;
}) {
  const byDate = new Map<string, DisplayState["chores"]>();
  for (const chore of state.chores) {
    const list = byDate.get(chore.date) ?? [];
    list.push(chore);
    byDate.set(chore.date, list);
  }
  if (byDate.size === 0) {
    // No card at all beats an empty card on a lobby wall.
    return <div className="display-chores-board display-chores-board-empty" />;
  }

  return (
    <div className="display-chores-board display-card">
      <h4 className="display-card-title">
        <span className="display-card-icon">✔</span>Chores
      </h4>
      {[...byDate.entries()].map(([date, chores]) => (
        <div key={date} className="display-chores-day">
          <span className="display-chores-date">
            {choreDayLabel(date, state.window.start)}
          </span>
          <ul className="display-card-list">
            {chores.map((chore, index) => (
              <li key={`${date}-${index}`} className="display-chore">
                <span className="display-chore-title">{chore.title}</span>
                {chore.assigneeLabels.length > 0 && (
                  <span className="display-chore-assignees">
                    {" "}
                    — <b>{chore.assigneeLabels.join(", ")}</b>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
