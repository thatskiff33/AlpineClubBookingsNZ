import { FinanceDashboardClient } from "@/app/(finance)/finance/_components/finance-dashboard-client";
import { buildFinanceDashboardPageModel } from "@/lib/finance-dashboard-page";
import { requireFinanceViewer } from "@/lib/finance-auth";

type FinanceDashboardSearchParams = Promise<
  Record<string, string | string[] | undefined>
>;

export default async function FinancePage({
  searchParams,
}: {
  searchParams?: FinanceDashboardSearchParams;
}) {
  const member = await requireFinanceViewer("/finance");
  const model = await buildFinanceDashboardPageModel({
    member,
    searchParams: searchParams ? await searchParams : undefined,
  });

  return <FinanceDashboardClient model={model} />;
}
