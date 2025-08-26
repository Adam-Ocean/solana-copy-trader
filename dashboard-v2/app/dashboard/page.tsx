"use client";

import { useUser } from "@stackframe/stack";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function Dashboard() {
  const user = useUser();
  const router = useRouter();

  useEffect(() => {
    // Redirect to login if not authenticated
    if (user === null) {
      router.push("/login");
    }
  }, [user, router]);

  // Show loading while checking auth
  if (user === undefined) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-black">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  // User is null (not authenticated)
  if (user === null) {
    return null;
  }

  // User is authenticated - redirect to main app
  router.push("/");
  return null;
}