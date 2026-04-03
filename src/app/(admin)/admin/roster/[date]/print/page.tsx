"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"

interface Assignment {
  id: string
  choreTemplateId: string
  choreTemplateName: string
  choreDescription: string | null
  choreSortOrder: number
  bookingGuestId: string | null
  guestName: string | null
  guestAgeTier: string | null
  bookingId: string
  status: string
}

interface RosterData {
  date: string
  guestCount: number
  assignments: Assignment[]
}

export default function PrintRosterPage() {
  const params = useParams()
  const dateStr = params.date as string
  const [roster, setRoster] = useState<RosterData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/admin/roster/${dateStr}`)
        if (!res.ok) throw new Error("Failed to load roster")
        const data = await res.json()
        setRoster(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load")
      } finally {
        setLoading(false)
      }
    }
    if (dateStr) load()
  }, [dateStr])

  if (loading) return <div className="p-8 text-center">Loading...</div>
  if (error) return <div className="p-8 text-center text-red-600">{error}</div>
  if (!roster) return null

  // Group assignments by chore, sorted by choreSortOrder
  const byChore = new Map<string, { name: string; description: string | null; sortOrder: number; guests: Array<{ name: string; ageTier: string | null }> }>()
  for (const a of roster.assignments) {
    if (!byChore.has(a.choreTemplateId)) {
      byChore.set(a.choreTemplateId, {
        name: a.choreTemplateName,
        description: a.choreDescription,
        sortOrder: a.choreSortOrder,
        guests: [],
      })
    }
    if (a.guestName) {
      byChore.get(a.choreTemplateId)!.guests.push({
        name: a.guestName,
        ageTier: a.guestAgeTier,
      })
    }
  }

  const chores = [...byChore.values()].sort((a, b) => a.sortOrder - b.sortOrder)
  const formattedDate = new Date(dateStr + "T00:00:00").toLocaleDateString("en-NZ", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  })

  return (
    <>
      <style jsx global>{`
        @media print {
          body { margin: 0; padding: 0; }
          .no-print { display: none !important; }
          @page { margin: 1.5cm; size: A4; }
        }
      `}</style>

      <div className="max-w-[800px] mx-auto p-8 print:p-0">
        {/* Print button - hidden in print */}
        <div className="no-print mb-6 flex items-center justify-between">
          <button
            onClick={() => window.print()}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Print Roster
          </button>
          <a href="/admin/roster" className="text-blue-600 hover:underline">
            Back to Roster
          </a>
        </div>

        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold">Tokoroa Alpine Club</h1>
          <h2 className="text-xl mt-1">Chore Roster</h2>
          <p className="text-lg mt-1">{formattedDate}</p>
          <p className="text-sm text-gray-600 mt-1">
            {roster.guestCount} guest{roster.guestCount !== 1 ? "s" : ""} staying
          </p>
        </div>

        {/* Roster Table */}
        <table className="w-full border-collapse border border-gray-400 text-sm">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-400 px-3 py-2 text-left w-8">#</th>
              <th className="border border-gray-400 px-3 py-2 text-left w-48">Chore</th>
              <th className="border border-gray-400 px-3 py-2 text-left">Assigned To</th>
              <th className="border border-gray-400 px-3 py-2 text-left">Description</th>
            </tr>
          </thead>
          <tbody>
            {chores.map((chore, idx) => (
              <tr key={idx} className={idx % 2 === 0 ? "" : "bg-gray-50"}>
                <td className="border border-gray-400 px-3 py-2 text-center font-mono">
                  {chore.sortOrder}
                </td>
                <td className="border border-gray-400 px-3 py-2 font-medium">
                  {chore.name}
                </td>
                <td className="border border-gray-400 px-3 py-2">
                  {chore.guests.map((g) => g.name).join(", ") || "Unassigned"}
                </td>
                <td className="border border-gray-400 px-3 py-2 text-xs text-gray-700">
                  {chore.description || ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Footer note */}
        <div className="mt-6 p-3 border-2 border-gray-800 bg-yellow-50 text-center">
          <p className="font-bold text-sm">
            Last person to bed: Check heaters and fire are safe and doors are secure.
          </p>
        </div>
      </div>
    </>
  )
}
