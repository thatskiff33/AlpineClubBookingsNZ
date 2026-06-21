"use client";

import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { useHealthData } from "../health/_components/use-health-data";
import { EmailDeliverabilitySection } from "../health/_components/email-deliverability-section";

export default function EmailDeliverabilityPage() {
  const { data, loading, error, setError, lastRefresh, refresh } = useHealthData();

  return (
    <div className="p-6 space-y-6">
      <div>
        <Link
          href="/admin/health"
          className="text-sm font-medium text-brand-charcoal underline decoration-brand-gold/70 decoration-2 underline-offset-4"
        >
          ← System Health
        </Link>
        <div className="flex items-center justify-between mt-2">
          <h1 className="text-2xl font-bold text-slate-900">
            Email Deliverability
          </h1>
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-500">
              Last refresh: {lastRefresh.toLocaleTimeString("en-NZ")}
            </span>
            <button
              onClick={refresh}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-slate-100 hover:bg-slate-200 rounded-md transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
        </div>
        <p className="mt-1 text-sm text-slate-500">
          Recipient suppressions and exhausted send failures.
        </p>
      </div>

      {loading && !data ? (
        <div className="animate-pulse space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="h-32 bg-slate-100 rounded-lg" />
          ))}
        </div>
      ) : error && !data ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          Failed to load health data: {error}
        </div>
      ) : data ? (
        <>
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
              {error}
            </div>
          )}
          <EmailDeliverabilitySection
            emailDeliverability={data.emailDeliverability}
            emailFailures={data.emailFailures}
            adminAlertDelivery={data.adminAlertDelivery}
            tokenEmailRecovery={data.tokenEmailRecovery}
            onRefresh={refresh}
            onError={setError}
          />
        </>
      ) : null}
    </div>
  );
}
