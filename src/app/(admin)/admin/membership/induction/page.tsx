import Link from "next/link";
import { Button } from "@/components/ui/button";
import { InductionRegisterTable } from "@/components/admin/induction-register-table";

import { adminHref } from "@/lib/admin-hubs";
export default function AdminInductionPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Induction Register</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Start member, hut-leader, youth-to-full, and re-induction workflows;
            track sign-offs and assigned signers.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href={adminHref("induction-settings")}>Induction settings</Link>
        </Button>
      </div>

      <InductionRegisterTable />
    </div>
  );
}
