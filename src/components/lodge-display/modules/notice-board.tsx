import type { DisplayState } from "@/lib/lodge-display-state";
import { resolveDisplayText } from "@/lib/lodge-display/display-text";
import type { DisplayPanelOptions } from "./module-options";
import { useClubFormat } from "@/components/club-format-provider";

// The committee notice board (fork issue #36): the one deliberately AUTHORED
// display surface — free text posted by permitted admins, rendered strictly
// as React text nodes (never HTML), so a notice can never inject markup.
// {{config:<key>}} / {{lodge-name}} / {{display-date}} placeholders resolve
// inside it. Empty notice renders nothing; the "content:notice" rotation
// condition lets templates skip the panel entirely.

export function NoticeBoard({
  state,
}: {
  state: DisplayState;
  options?: DisplayPanelOptions;
}) {
  const format = useClubFormat();
  if (!state.notice) {
    return <div className="display-notice-board display-notice-empty" />;
  }

  const resolved = resolveDisplayText(state.notice, state, format);
  const paragraphs = resolved
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return (
    <div className="display-notice-board">
      <span className="display-notice-kicker">Committee notice</span>
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="display-notice-text">
          {paragraph}
        </p>
      ))}
    </div>
  );
}
