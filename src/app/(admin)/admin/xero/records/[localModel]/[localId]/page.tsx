import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { XeroRecordActivityPanel } from "@/components/admin/xero-record-activity-panel";
import { getXeroRecordActivity } from "@/lib/xero-record-activity";
import { isXeroLocalModel } from "@/lib/xero-record-links";

export default async function XeroRecordActivityPage({
  params,
}: {
  params: Promise<{ localModel: string; localId: string }>;
}) {
  const { localModel, localId } = await params;

  if (!isXeroLocalModel(localModel)) {
    notFound();
  }

  const data = await getXeroRecordActivity(localModel, localId, 25);
  if (!data) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Button variant="ghost" size="sm" asChild className="-ml-2 w-fit">
          <Link href={data.backLink?.href ?? "/admin/xero"}>
            <ArrowLeft className="h-4 w-4" />
            {data.backLink?.label ?? "Back to Xero"}
          </Link>
        </Button>
        <div className="space-y-1">
          <p className="text-sm font-medium text-slate-500">Xero record activity</p>
          <h1 className="text-3xl font-bold text-slate-900">{data.rootRecord.label}</h1>
          <p className="text-sm text-slate-500">
            Record-scoped operations, replay status, and Xero links for this {data.rootRecord.relation.toLowerCase()}.
          </p>
        </div>
      </div>

      <XeroRecordActivityPanel
        localModel={localModel}
        localId={localId}
        initialData={data}
      />
    </div>
  );
}
