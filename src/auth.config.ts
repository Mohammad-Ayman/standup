/**
 * Edge-safe Auth.js (next-auth v5) base config — shared between the full
 * node instance in src/auth.ts and the edge middleware in src/middleware.ts.
 *
 * MUST NOT import the db, pg, or anything node-only: the middleware runs on
 * the edge runtime and only needs to verify the session JWT cookie. All
 * db-touching callbacks (allowlist check, users upsert) live in src/auth.ts.
 */
import type { NextAuthConfig } from "next-auth";
import GitHub from "next-auth/providers/github";

export const authConfig = {
  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET,
    }),
  ],
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  // Self-hosted deployments sit behind arbitrary hostnames/proxies.
  trustHost: true,
} satisfies NextAuthConfig;
