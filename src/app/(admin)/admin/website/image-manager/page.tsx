import { BackLink } from "@/components/admin/back-link";
import { ImageManagerClient } from "./image-manager-client";
import { adminLink } from "@/lib/admin-hubs";

export default function ImageManagerPage() {
  return (
    <div className="space-y-6">
      <BackLink {...adminLink("appearance")} />
      <ImageManagerClient />
    </div>
  );
}
