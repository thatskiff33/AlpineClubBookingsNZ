"use client";

import { useEffect, useState } from "react";
import type { WhakapapaCurlData } from "@/lib/whakapapa-report";

type ApiResponse = WhakapapaCurlData & { error?: string; stale?: boolean };

const EMPTY_DATA: WhakapapaCurlData = {
  updated: "",
  roadStatus: {
    name: "",
    status: "",
    wheelRequirements: "",
    roadContent: "",
  },
  chairlifts: [],
  conditions: [],
};

export function SkifieldWhakapapaWidget() {
  const [data, setData] = useState<WhakapapaCurlData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const response = await fetch("/api/skifield-whakapapa", {
          method: "GET",
          cache: "no-store",
        });
        const payload = (await response.json()) as ApiResponse;
        if (!active) {
          return;
        }

        setData({
          updated: payload.updated || "",
          roadStatus: {
            name: payload.roadStatus?.name || "",
            status: payload.roadStatus?.status || "",
            wheelRequirements: payload.roadStatus?.wheelRequirements || "",
            roadContent: payload.roadStatus?.roadContent || "",
          },
          chairlifts: payload.chairlifts ?? [],
          conditions: payload.conditions ?? [],
        });

        setError(payload.error || "");
        setStale(Boolean(payload.stale));
      } catch {
        if (!active) {
          return;
        }
        setError("Unable to load Whakapapa report data.");
        setStale(false);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
        Loading Whakapapa report...
      </div>
    );
  }

  const formattedUpdated = data.updated
    ? new Date(data.updated).toLocaleString("en-NZ", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Unknown";

  const roadStatusTone = /open/i.test(data.roadStatus.status)
    ? "bg-emerald-100 text-emerald-800"
    : data.roadStatus.status
      ? "bg-amber-100 text-amber-800"
      : "bg-slate-100 text-slate-700";

  return (
    <section
      id="conditions"
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
    >
      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Whakapapa Conditions
          </h2>
          <p className="text-xs text-slate-500">Updated: {formattedUpdated}</p>
        </div>
        {stale ? (
          <span className="inline-flex rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800">
            Showing cached data
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <article className="rounded-md border border-slate-200 bg-slate-50 p-4">
          <h3 className="text-sm font-semibold text-slate-900">Road Status</h3>
          <p className="mt-2 text-sm text-slate-700">
            {data.roadStatus.name || "Unknown road"}
          </p>
          <p className="mt-2">
            <span
              className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${roadStatusTone}`}
            >
              {data.roadStatus.status || "Status unavailable"}
            </span>
          </p>
          {data.roadStatus.wheelRequirements || data.roadStatus.roadContent ? (
            <dl className="mt-3 space-y-2 text-xs text-slate-600">
              {data.roadStatus.wheelRequirements ? (
                <div>
                  <dt className="font-medium text-slate-700">
                    Wheel requirements
                  </dt>
                  <dd>{data.roadStatus.wheelRequirements}</dd>
                </div>
              ) : null}
              {data.roadStatus.roadContent ? (
                <div>
                  <dt className="font-medium text-slate-700">Road content</dt>
                  <dd>{data.roadStatus.roadContent}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </article>

        <article className="rounded-md border border-slate-200 bg-slate-50 p-4">
          <h3 className="text-sm font-semibold text-slate-900">Chairlifts</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-xs text-slate-700">
              <thead className="text-slate-500">
                <tr>
                  <th className="pb-2 pr-4 font-medium">Lift</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.chairlifts.length > 0 ? (
                  data.chairlifts.map((lift) => (
                    <tr
                      key={`${lift.name}-${lift.status}`}
                      className="border-t border-slate-200"
                    >
                      <td className="py-2 pr-4">{lift.name || "Unknown"}</td>
                      <td className="py-2">{lift.status || "Unknown"}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="py-2 pr-4 text-slate-500" colSpan={2}>
                      No chairlift data available.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>
      </div>

      <article className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-4">
        <h3 className="text-sm font-semibold text-slate-900">
          Mountain Conditions
        </h3>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-xs text-slate-700">
            <thead className="text-slate-500">
              <tr>
                <th className="pb-2 pr-4 font-medium">Location</th>
                <th className="pb-2 pr-4 font-medium">Temp</th>
                <th className="pb-2 pr-4 font-medium">Wind</th>
                <th className="pb-2 pr-4 font-medium">Snow Base</th>
                <th className="pb-2 pr-4 font-medium">24h</th>
                <th className="pb-2 font-medium">7d</th>
              </tr>
            </thead>
            <tbody>
              {data.conditions.length > 0 ? (
                data.conditions.map((condition) => (
                  <tr
                    key={condition.name}
                    className="border-t border-slate-200"
                  >
                    <td className="py-2 pr-4 font-medium text-slate-800">
                      {condition.name || "Unknown"}
                    </td>
                    <td className="py-2 pr-4">
                      {condition.temperature || "-"}
                    </td>
                    <td className="py-2 pr-4">{condition.wind || "-"}</td>
                    <td className="py-2 pr-4">{condition.snowBase || "-"}</td>
                    <td className="py-2 pr-4">
                      {condition.snowfall24h || "-"}
                    </td>
                    <td className="py-2">{condition.snowfall7d || "-"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="py-2 text-slate-500" colSpan={6}>
                    No condition data available.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  );
}
