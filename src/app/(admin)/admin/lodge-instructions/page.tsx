import { LodgeInstructionsPanel } from "@/components/admin/lodge-instructions-panel";

export default function LodgeInstructionsAdminPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Lodge Instructions</h1>
        <p className="mt-1 text-sm text-slate-500">
          Maintain the opening, closing, and day-to-day instructions hut
          leaders rely on. These documents are protected content: they are
          only visible to admins and assigned hut leaders, never on the
          public website.
        </p>
      </div>

      <LodgeInstructionsPanel />
    </div>
  );
}
