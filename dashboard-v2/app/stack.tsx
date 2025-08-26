"use client";

import { StackProvider, StackClientApp } from "@stackframe/stack";

const stackApp = new StackClientApp({
  tokenStore: "nextjs-cookie",
  projectId: process.env.NEXT_PUBLIC_STACK_PROJECT_ID!,
  publishableClientKey: process.env.NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY!,
  urls: {
    home: "/",
    signIn: "/login",
    afterSignIn: "/",
    afterSignUp: "/",
    afterSignOut: "/login",
    handler: "/handler",
  }
});

export default function Provider({ children }: { children: React.ReactNode }) {
  return (
    <StackProvider app={stackApp}>
      {children}
    </StackProvider>
  );
}