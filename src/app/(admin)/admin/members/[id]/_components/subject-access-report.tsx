import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function SubjectAccessReport({ memberId }: { memberId: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Subject access report</CardTitle>
        <CardDescription>
          Verify the person’s identity and authority before providing their file.
          Each download is recorded in the audit log. The file lists exclusions
          that need privacy officer review.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button asChild variant="outline">
          <a href={`/api/admin/members/subject-access?memberId=${encodeURIComponent(memberId)}`}>
            Download this person’s report
          </a>
        </Button>
        <form action="/api/admin/members/subject-access" method="get" className="space-y-2">
          <Label htmlFor="subject-access-email">Another member or booking requester’s email</Label>
          <Input id="subject-access-email" type="email" name="email" required maxLength={200} />
          <Button type="submit" variant="outline">Download report by email</Button>
        </form>
        <form action="/api/admin/members/subject-access" method="get" className="space-y-2">
          <Label htmlFor="subject-access-guest">Non-member booking guest ID</Label>
          <Input id="subject-access-guest" name="guestId" required />
          <p className="text-sm text-muted-foreground">Guest records do not hold email addresses. Confirm the exact guest row first.</p>
          <Button type="submit" variant="outline">Download guest’s report</Button>
        </form>
      </CardContent>
    </Card>
  );
}
