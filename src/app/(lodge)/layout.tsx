import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export default async function LodgeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  // Only LODGE and ADMIN roles can access lodge pages
  if (session.user.role !== "LODGE" && session.user.role !== "ADMIN") {
    redirect("/dashboard");
  }

  return <>{children}</>;
}
