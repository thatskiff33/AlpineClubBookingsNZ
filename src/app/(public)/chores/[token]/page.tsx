"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, Circle, AlertTriangle, Mountain, Lock } from "lucide-react";

interface Assignment {
  id: string;
  choreTemplateName: string;
  choreDescription: string | null;
  choreTimeOfDay: string;
  choreSortOrder: number;
  status: string;
  completedAt: string | null;
  completedVia: string | null;
}

interface GuestChoreData {
  date: string;
  guest: { id: string; firstName: string; lastName: string };
  assignments: Assignment[];
}

export default function GuestChorePage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<GuestChoreData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch(`/api/chores/${token}`);
        if (!res.ok) {
          const err = await res.json();
          setError(err.error || "Invalid or expired link");
          return;
        }
        setData(await res.json());
      } catch {
        setError("Failed to load chore data");
      } finally {
        setLoading(false);
      }
    };

    void fetchData();
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <p className="text-slate-500">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <div className="max-w-md w-full text-center space-y-4">
          <AlertTriangle className="h-12 w-12 text-amber-500 mx-auto" />
          <h1 className="text-xl font-bold text-slate-900">Link Unavailable</h1>
          <p className="text-slate-600">{error}</p>
          <p className="text-sm text-slate-500">
            This link may have expired (48 hours) or is invalid.
            Contact the lodge if you need a new link.
          </p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const formattedDate = new Date(data.date + "T00:00:00").toLocaleDateString("en-NZ", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const groups: Record<string, Assignment[]> = { MORNING: [], EVENING: [], ANYTIME: [] };
  for (const a of data.assignments) {
    (groups[a.choreTimeOfDay] ?? groups.ANYTIME).push(a);
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-blue-800 text-white px-4 py-4">
        <div className="max-w-lg mx-auto flex items-center gap-2">
          <Mountain className="h-5 w-5" />
          <span className="font-bold">Tokoroa Alpine Club Lodge Chores</span>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">
            {data.guest.firstName} {data.guest.lastName}
          </h1>
          <p className="text-sm text-slate-600">{formattedDate}</p>
        </div>

        {data.assignments.length === 0 ? (
          <p className="text-slate-500">No chores assigned.</p>
        ) : (
          Object.entries(groups).map(([timeOfDay, chores]) => {
            if (chores.length === 0) return null;
            const label =
              timeOfDay === "MORNING" ? "Morning" :
              timeOfDay === "EVENING" ? "Evening" : "Anytime";
            return (
              <div key={timeOfDay} className="space-y-2">
                <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
                  {label}
                </h2>
                {chores
                  .sort((a, b) => a.choreSortOrder - b.choreSortOrder)
                  .map((a) => (
                    <div
                      key={a.id}
                      className={`w-full text-left flex items-center gap-3 p-4 rounded-lg border transition-colors ${
                        a.status === "COMPLETED"
                          ? "bg-green-50 border-green-200"
                          : "bg-white border-slate-200"
                      }`}
                    >
                      {a.status === "COMPLETED" ? (
                        <CheckCircle2 className="h-6 w-6 text-green-600 shrink-0" />
                      ) : (
                        <Circle className="h-6 w-6 text-slate-300 shrink-0" />
                      )}
                      <div>
                        <div className={`font-medium ${a.status === "COMPLETED" ? "text-green-800 line-through" : "text-slate-900"}`}>
                          {a.choreTemplateName}
                        </div>
                        {a.choreDescription && (
                          <div className="text-sm text-slate-500">{a.choreDescription}</div>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            );
          })
        )}

        <div className="flex gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          <span>Chore completion updates require an authenticated lodge or member session.</span>
        </div>

        <p className="text-xs text-slate-400 text-center mt-8">
          This link expires after 48 hours.
        </p>
      </main>
    </div>
  );
}
