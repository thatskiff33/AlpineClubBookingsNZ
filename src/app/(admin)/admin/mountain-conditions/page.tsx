import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MountainConditionsPanel } from "./_components/mountain-conditions-panel";

export default function MountainConditionsAdminPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          Mountain Conditions
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Review and edit the cached Whakapapa mountain conditions JSON payload.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Whakapapa cache</CardTitle>
          <CardDescription>
            Save changes to freeze automatic upstream updates for 12 hours, or
            use Update from upstream to refresh immediately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MountainConditionsPanel />
        </CardContent>
      </Card>
    </div>
  );
}
