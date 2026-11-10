import { BackLink } from "@/components/admin/back-link";
import { adminLink } from "@/lib/admin-hubs";
import { AdultMemberHostingSection } from "@/components/admin/booking-policies/adult-member-hosting-section";

export default function AdultMemberHostingPage() {
  return (
    <div className="space-y-6">
      <div>
        <BackLink {...adminLink("booking-policies")} />
        <h1 className="mt-2 text-2xl font-bold text-foreground">
          Adult Member Hosting
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ask that an adult member is staying on the same booking as any
          non-member guest, on every night that guest is there.
        </p>
      </div>

      <AdultMemberHostingSection />
    </div>
  );
}
