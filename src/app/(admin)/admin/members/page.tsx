import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Users } from "lucide-react";

interface MembersPageProps {
  searchParams: Promise<{ q?: string }>;
}

async function getMembers(query?: string) {
  return prisma.member.findMany({
    where: query
      ? {
          OR: [
            { firstName: { contains: query, mode: "insensitive" } },
            { lastName: { contains: query, mode: "insensitive" } },
            { email: { contains: query, mode: "insensitive" } },
          ],
        }
      : undefined,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      role: true,
      ageTier: true,
      active: true,
      createdAt: true,
    },
  });
}

export default async function MembersPage({ searchParams }: MembersPageProps) {
  const { q } = await searchParams;
  const members = await getMembers(q);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Members</h1>
          <p className="mt-1 text-sm text-slate-500">
            {members.length} member{members.length !== 1 ? "s" : ""}
            {q ? ` matching "${q}"` : " total"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-slate-400" />
        </div>
      </div>

      {/* Search */}
      <form method="GET">
        <div className="flex max-w-sm gap-2">
          <Input
            name="q"
            defaultValue={q}
            placeholder="Search by name or email..."
            className="bg-white"
          />
          <button
            type="submit"
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            Search
          </button>
          {q && (
            <a
              href="/admin/members"
              className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              Clear
            </a>
          )}
        </div>
      </form>

      {/* Members table */}
      <Card>
        <CardHeader className="pb-0">
          <CardTitle className="text-base font-medium">Member List</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {members.length === 0 ? (
            <div className="py-12 text-center">
              <Users className="mx-auto h-10 w-10 text-slate-300 mb-3" />
              <p className="text-sm font-medium text-slate-500">
                {q ? `No members found matching "${q}"` : "No members yet"}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Age Tier</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Joined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((member) => (
                    <TableRow key={member.id} className="hover:bg-slate-50">
                      <TableCell className="font-medium">
                        {member.firstName} {member.lastName}
                      </TableCell>
                      <TableCell className="text-slate-600">
                        {member.email}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            member.role === "ADMIN" ? "default" : "secondary"
                          }
                          className={
                            member.role === "ADMIN"
                              ? "bg-blue-600 text-white hover:bg-blue-700"
                              : ""
                          }
                        >
                          {member.role}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-slate-600">
                          {member.ageTier.charAt(0) +
                            member.ageTier.slice(1).toLowerCase()}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={member.active ? "default" : "destructive"}
                          className={
                            member.active
                              ? "bg-green-100 text-green-800 hover:bg-green-200 border-green-200"
                              : ""
                          }
                        >
                          {member.active ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-slate-500 text-sm">
                        {new Date(member.createdAt).toLocaleDateString(
                          "en-NZ",
                          {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          }
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
