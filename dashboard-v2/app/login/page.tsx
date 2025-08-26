"use client";

import { useStackApp, useUser } from "@stackframe/stack";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Whitelist of allowed email addresses
const ALLOWED_EMAILS = [
  // Add your email here
  process.env.NEXT_PUBLIC_ADMIN_EMAIL || "me@adamx.cloud",
  "me@adamx.cloud" // Hardcoded as backup
];

export default function LoginPage() {
  const user = useUser();
  const router = useRouter();
  const stackApp = useStackApp();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // If already authenticated, redirect to main page
    if (user) {
      // Check if user is whitelisted
      if (user.primaryEmail && ALLOWED_EMAILS.includes(user.primaryEmail)) {
        router.push("/");
      } else {
        // Sign out non-whitelisted users
        user.signOut();
        setError("Access denied. This account is not authorized.");
      }
    }
  }, [user, router]);

  const handleGoogleSignIn = async () => {
    try {
      setIsLoading(true);
      setError("");
      await stackApp.signInWithOAuth("google");
    } catch (err) {
      setError("Failed to sign in with Google");
      setIsLoading(false);
    }
  };

  const handleGitHubSignIn = async () => {
    try {
      setIsLoading(true);
      setError("");
      await stackApp.signInWithOAuth("github");
    } catch (err) {
      setError("Failed to sign in with GitHub");
      setIsLoading(false);
    }
  };

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Check if email is whitelisted before attempting sign in
    if (!ALLOWED_EMAILS.includes(email)) {
      setError("Access denied. This email is not authorized.");
      return;
    }

    try {
      setIsLoading(true);
      setError("");
      const result = await stackApp.signInWithCredential({
        email,
        password,
        noRedirect: true
      });
      
      if (result.status === "error") {
        setError("Invalid email or password");
      } else {
        router.push("/");
      }
    } catch (err) {
      setError("Failed to sign in");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-gradient-to-br from-black via-gray-900 to-black">
      {/* Background pattern */}
      <div className="absolute inset-0 bg-[url('/grid.svg')] bg-center [mask-image:linear-gradient(180deg,white,rgba(255,255,255,0))]"></div>
      
      <div className="relative w-full max-w-md p-8">
        {/* Logo and Title */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl mb-4">
            <span className="text-2xl font-bold text-white">CT</span>
          </div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent mb-2">
            Copy Trader Pro
          </h1>
          <p className="text-gray-500 text-sm">Private Access Only</p>
        </div>

        {/* Login Form */}
        <div className="bg-gray-900/30 backdrop-blur-xl rounded-2xl p-8 border border-gray-800/50 shadow-2xl">
          <h2 className="text-xl font-semibold text-white mb-6">Sign in to your account</h2>
          
          {/* OAuth Buttons */}
          <div className="space-y-3 mb-6">
            <Button
              onClick={handleGoogleSignIn}
              disabled={isLoading}
              className="w-full h-11 bg-white hover:bg-gray-100 text-gray-900 font-medium rounded-lg transition-all duration-200 flex items-center justify-center gap-3"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Sign in with Google
            </Button>

            <Button
              onClick={handleGitHubSignIn}
              disabled={isLoading}
              className="w-full h-11 bg-gray-800 hover:bg-gray-700 text-white font-medium rounded-lg transition-all duration-200 flex items-center justify-center gap-3"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
              </svg>
              Sign in with GitHub
            </Button>
          </div>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-700"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-4 bg-gray-900/30 text-gray-500">Or continue with</span>
            </div>
          </div>

          {/* Email/Password Form */}
          <form onSubmit={handleEmailSignIn} className="space-y-4">
            <div>
              <Label htmlFor="email" className="text-gray-300 text-sm font-medium">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full h-11 bg-gray-800/50 border-gray-700 text-white placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded-lg"
                placeholder="your-email@example.com"
                required
              />
            </div>

            <div>
              <Label htmlFor="password" className="text-gray-300 text-sm font-medium">
                Password
              </Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full h-11 bg-gray-800/50 border-gray-700 text-white placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded-lg"
                placeholder="••••••••"
                required
              />
            </div>

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            <Button
              type="submit"
              disabled={isLoading}
              className="w-full h-11 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white font-medium rounded-lg transition-all duration-200"
            >
              {isLoading ? "Signing in..." : "Sign in"}
            </Button>
          </form>

          <p className="mt-6 text-center text-xs text-gray-500">
            Access restricted to authorized accounts only.
            <br />
            New registrations are currently disabled.
          </p>
        </div>
      </div>
    </div>
  );
}