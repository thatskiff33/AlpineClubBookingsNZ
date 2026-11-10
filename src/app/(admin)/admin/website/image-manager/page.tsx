import { BackLink } from "@/components/admin/back-link";
import { adminLink } from "@/lib/admin-hubs";
import { ImageManagerClient } from "./image-manager-client";

export default function ImageManagerPage() {
  return (
    <div className="space-y-6">
      <BackLink {...adminLink("appearance")} />
      <ImageManagerClient />
    </div>
  );
}
