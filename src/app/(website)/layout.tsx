import { auth } from "@/lib/auth";
import { WebsiteHeader } from "@/components/website-header";
import { WebsiteFooter } from "@/components/website-footer";

export default async function WebsiteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <div className="min-h-screen flex flex-col">
      <WebsiteHeader isAuthenticated={!!session?.user} />
      <main className="flex-1">{children}</main>
      <WebsiteFooter />
    </div>
  );
}
