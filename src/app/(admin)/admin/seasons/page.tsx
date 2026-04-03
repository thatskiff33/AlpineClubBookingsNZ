import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCents } from "@/lib/utils";
import { SeasonForm } from "@/components/admin/season-form";

export default async function AdminSeasonsPage() {
  const seasons = await prisma.season.findMany({
    include: { rates: true },
    orderBy: { startDate: "desc" },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Seasons & Rates</h1>
      </div>

      <SeasonForm />

      {seasons.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-gray-500">
            No seasons configured. Create one above.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {seasons.map((season) => (
            <Card key={season.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">{season.name}</CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant={season.active ? "success" : "secondary"}>
                      {season.active ? "Active" : "Inactive"}
                    </Badge>
                    <Badge variant="outline">{season.type}</Badge>
                  </div>
                </div>
                <p className="text-sm text-gray-500">
                  {new Date(season.startDate).toLocaleDateString("en-NZ")} -{" "}
                  {new Date(season.endDate).toLocaleDateString("en-NZ")}
                </p>
              </CardHeader>
              <CardContent>
                {season.rates.length === 0 ? (
                  <p className="text-sm text-gray-500">No rates configured yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-2 pr-4">Age Tier</th>
                          <th className="text-left py-2 pr-4">Member</th>
                          <th className="text-right py-2">Price/Night</th>
                        </tr>
                      </thead>
                      <tbody>
                        {season.rates
                          .sort((a, b) => {
                            const tierOrder = { ADULT: 0, YOUTH: 1, CHILD: 2 };
                            const diff = tierOrder[a.ageTier] - tierOrder[b.ageTier];
                            if (diff !== 0) return diff;
                            return a.isMember ? -1 : 1;
                          })
                          .map((rate) => (
                            <tr key={rate.id} className="border-b last:border-0">
                              <td className="py-2 pr-4">{rate.ageTier}</td>
                              <td className="py-2 pr-4">{rate.isMember ? "Yes" : "No"}</td>
                              <td className="py-2 text-right font-medium">
                                {formatCents(rate.pricePerNightCents)}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
