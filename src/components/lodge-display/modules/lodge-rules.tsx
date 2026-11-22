import type { DisplayState } from "@/lib/lodge-display-state";
import type { DisplayPanelOptions } from "./module-options";

// Lodge rules / arrival information (fork issue hoppers99/AlpineClubBookingsNZ#31): renders the sanitised
// lodge-instructions documents the serialiser provided. The HTML was
// sanitised server-side by getSanitizedLodgeInstructions before it entered
// the payload (issue hoppers99/AlpineClubBookingsNZ#28); this module renders that payload verbatim and
// nothing else (issue hoppers99/AlpineClubBookingsNZ#31 AC2).

export function LodgeRules({
  state,
}: {
  state: DisplayState;
  options?: DisplayPanelOptions;
}) {
  // Instruction docs arrive as a fixed keyed set; only the ones with actual
  // content earn a card (issue hoppers99/AlpineClubBookingsNZ#56 — no empty cards on a lobby wall).
  const docs = (state.rules ?? []).filter((doc) => doc.html.trim().length > 0);
  if (docs.length === 0) {
    return <div className="display-lodge-rules display-lodge-rules-empty" />;
  }

  return (
    <div className="display-lodge-rules">
      {docs.map((doc) => (
        <section key={doc.title} className="display-rules-doc display-card">
          <h4 className="display-card-title">
            <span className="display-card-icon">›</span>
            {doc.title}
          </h4>
          <div
            className="display-rules-body"
            // Sanitised upstream (getSanitizedLodgeInstructions → serialiser).
            dangerouslySetInnerHTML={{ __html: doc.html }}
          />
        </section>
      ))}
    </div>
  );
}
