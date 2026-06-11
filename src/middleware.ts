/**
 * Route protection middleware — edge runtime.
 *
 * IMPORTANT: this file must stay edge-safe. It builds a *separate* NextAuth
 * instance from the db-free base config (src/auth.config.ts) and only checks
 * for a valid session JWT cookie. The allowlist/db checks run in the signIn
 * callback in src/auth.ts (node runtime).
 *
 * Everything is protected EXCEPT: /login, /api/auth/**, /api/health,
 * /_next/** and static assets (excluded via the matcher below).
 */
import NextAuth from "next-auth";

import { authConfig } from "@/auth.config";

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  if (!req.auth) {
    const loginUrl = new URL("/login", req.nextUrl.origin);
    // Relative path only — the login page rejects absolute callback URLs.
    loginUrl.searchParams.set(
      "callbackUrl",
      req.nextUrl.pathname + req.nextUrl.search,
    );
    return Response.redirect(loginUrl);
  }
});

export const config = {
  matcher: [
    // Everything except: /login, /api/auth/**, /api/health, Next.js
    // internals, favicon, and common static-asset extensions.
    "/((?!login|api/auth|api/health|_next|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|xml|woff2?|ttf)$).*)",
  ],
};
