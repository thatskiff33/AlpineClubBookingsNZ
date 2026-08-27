"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, Circle, AlertTriangle, Mountain, Lock } from "lucide-react";
import { useClubIdentity } from "@/components/club-identity-provider";
import { formatClubLongWeekdayDate, requireCalendarDate } from "@/lib/club-time";

// The chore sheet names the DAY OF THE WEEK in full ("Wednesday, 15 April
// 2026"), matching the chore-roster email subject. A CALENDAR DAY, SO NO
// TIMEZONE AT ALL (CT-4, #2870): the kernel's `longWeekdayDate` shape is that
// exact bag, pinned to `UTC` over the UTC-midnight encoding, which is provably
// the identity for every club.

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
  const club = useClubIdentity();
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
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="max-w-md w-full text-center space-y-4">
          <AlertTriangle className="h-12 w-12 text-warning-11 mx-auto" />
          <h1 className="text-xl font-bold text-foreground">Link Unavailable</h1>
          <p className="text-muted-foreground">{error}</p>
          <p className="text-sm text-muted-foreground">
            This link may have expired (48 hours) or is invalid.
            Contact the lodge if you need a new link.
          </p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  // A date-only chore night. `requireCalendarDate` rather than
  // `parseCalendarDate`: `data.date` is the `@db.Date` day this page was fetched
  // for, and there is no sensible fallback heading to show in its place.
  const formattedDate = formatClubLongWeekdayDate(requireCalendarDate(data.date));

  const groups: Record<string, Assignment[]> = { MORNING: [], EVENING: [], ANYTIME: [] };
  for (const a of data.assignments) {
    (groups[a.choreTimeOfDay] ?? groups.ANYTIME).push(a);
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-primary text-primary-foreground px-4 py-4">
        <div className="max-w-lg mx-auto flex items-center gap-2">
          <Mountain className="h-5 w-5" />
          <span className="font-bold">{club.lodgeName} Chores</span>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="text-xl font-bold text-foreground">
            {data.guest.firstName} {data.guest.lastName}
          </h1>
          <p className="text-sm text-muted-foreground">{formattedDate}</p>
        </div>

        {data.assignments.length === 0 ? (
          <p className="text-muted-foreground">No chores assigned.</p>
        ) : (
          Object.entries(groups).map(([timeOfDay, chores]) => {
            if (chores.length === 0) return null;
            const label =
              timeOfDay === "MORNING" ? "Morning" :
              timeOfDay === "EVENING" ? "Evening" : "Anytime";
            return (
              <div key={timeOfDay} className="space-y-2">
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  {label}
                </h2>
                {chores
                  .sort((a, b) => a.choreSortOrder - b.choreSortOrder)
                  .map((a) => (
                    <div
                      key={a.id}
                      className={`w-full text-left flex items-center gap-3 p-4 rounded-lg border transition-colors ${
                        a.status === "COMPLETED"
                          ? "bg-success-3 border-success-6"
                          : "bg-card border-border"
                      }`}
                    >
                      {a.status === "COMPLETED" ? (
                        <CheckCircle2 className="h-6 w-6 text-success-11 shrink-0" />
                      ) : (
                        <Circle className="h-6 w-6 text-muted-foreground shrink-0" />
                      )}
                      <div>
                        <div className={`font-medium ${a.status === "COMPLETED" ? "text-success-11 line-through" : "text-foreground"}`}>
                          {a.choreTemplateName}
                        </div>
                        {a.choreDescription && (
                          <div className="text-sm text-muted-foreground">{a.choreDescription}</div>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            );
          })
        )}

        <div className="flex gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span>Chore completion updates require an authenticated lodge or member session.</span>
        </div>

        <p className="text-xs text-muted-foreground text-center mt-8">
          This link expires after 48 hours.
        </p>
      </main>
    </div>
  );
}
