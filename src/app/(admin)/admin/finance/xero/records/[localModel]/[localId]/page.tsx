import { notFound } from "next/navigation";
import { BackLink } from "@/components/admin/back-link";
import { XeroRecordActivityPanel } from "@/components/admin/xero-record-activity-panel";
import { getXeroRecordActivity } from "@/lib/xero-record-activity";
import { isXeroLocalModel } from "@/lib/xero-record-links";
import { resolveInternalReturnPath } from "@/lib/internal-return-path";
import { clubFormatValues } from "@/lib/club-format-server";
import { adminLink } from "@/lib/admin-hubs";

export default async function XeroRecordActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ localModel: string; localId: string }>;
  searchParams?: Promise<{ returnTo?: string | string[] }>;
}) {
  const { localModel, localId } = await params;
  const query = searchParams ? await searchParams : {};

  if (!isXeroLocalModel(localModel)) {
    notFound();
  }

  // The club's format (#3565), resolved once per render pass.
  const format = await clubFormatValues();
  const data = await getXeroRecordActivity(localModel, localId, format, 25);
  if (!data) {
    notFound();
  }
  // Without a parent of its own, the record goes back to Xero Sync.
  const fallback = data.backLink ?? adminLink("xero");
  const backHref = resolveInternalReturnPath(query.returnTo, fallback.href);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <BackLink href={backHref} label={fallback.label} />
        <div className="space-y-1">
          <p className="text-sm font-medium text-muted-foreground">Xero record activity</p>
          <h1 className="text-3xl font-bold text-foreground">{data.rootRecord.label}</h1>
          <p className="text-sm text-muted-foreground">
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
