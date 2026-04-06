"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

function ConfirmEmailChangeContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  useEffect(() => {
    if (!token) return;
    window.location.href = `/api/auth/confirm-email-change?token=${encodeURIComponent(token)}`;
  }, [token]);

  if (!token) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center">Invalid Link</CardTitle>
        </CardHeader>
        <CardContent className="text-center space-y-4">
          <p className="text-muted-foreground">
            This email change link is invalid or missing.
          </p>
          <Button asChild>
            <Link href="/profile">Go to Profile</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-center">Confirming Email Change...</CardTitle>
      </CardHeader>
      <CardContent className="text-center">
        <p className="text-muted-foreground">Please wait while we update your email address.</p>
      </CardContent>
    </Card>
  );
}

export default function ConfirmEmailChangePage() {
  return (
    <Suspense fallback={
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center">Loading...</CardTitle>
        </CardHeader>
      </Card>
    }>
      <ConfirmEmailChangeContent />
    </Suspense>
  );
}
