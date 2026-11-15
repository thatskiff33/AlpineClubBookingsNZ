import { ServerCog } from "lucide-react";

// Static explainer at the top of the Modules page: what activation stores and
// what it leaves to each module's own setup. It holds no state, so the stateful
// page stays focused on loading, editing and saving the settings.
export function ModulesInfoNote() {
  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      <div className="flex items-start gap-3">
        <ServerCog className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>
            Module activation is stored in the database and does not store
            secrets, tokens, tenant ids, or provider credentials.
          </p>
          <p>
            A module is available across the site whenever it is enabled here.
            Some modules still need their own setup (for example Xero
            credentials) before they can do useful work.
          </p>
        </div>
      </div>
    </div>
  );
}
