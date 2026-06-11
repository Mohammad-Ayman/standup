/**
 * Full Auth.js (next-auth v5) instance — node runtime only.
 *
 * Extends the edge-safe base config (src/auth.config.ts) with the
 * db-touching callbacks:
 * - signIn: allowlist gate (case-insensitive) + users upsert
 * - jwt:    persist db user id + login into the token on first sign-in
 * - session: expose session.user.{id,login}
 *
 * The middleware (src/middleware.ts) deliberately does NOT import this file —
 * it builds its own instance from auth.config.ts so no pg code reaches the
 * edge bundle.
 */
import NextAuth, { type DefaultSession } from "next-auth";
// Type-only import so the "next-auth/jwt" module augmentation below resolves.
import type {} from "next-auth/jwt";
import { z } from "zod";

import { authConfig } from "@/auth.config";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { isAllowed } from "@/lib/allowlist";

// ---------------------------------------------------------------------------
// Type augmentation — session.user.{id,login} must typecheck app-wide
// ---------------------------------------------------------------------------
declare module "next-auth" {
  interface Session {
    user: {
      /** Database user id (users.id), stringified. */
      id: string;
      /** GitHub login of the signed-in user. */
      login: string;
    } & DefaultSession["user"];
  }

  interface User {
    /** GitHub login, stashed by the signIn callback for the jwt callback. */
    login?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    login?: string;
  }
}

// ---------------------------------------------------------------------------
// Raw GitHub OAuth profile — validate at the boundary with zod
// ---------------------------------------------------------------------------
const GithubProfileZ = z.object({
  // GitHub sends a number; Auth.js types it loosely — coerce to be safe.
  id: z.coerce.number().int(),
  login: z.string().min(1),
  name: z.string().nullish(),
  avatar_url: z.string().nullish(),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    /**
     * Allowlist gate + user upsert. Runs in the node runtime (route handler),
     * so db access is fine here — never in middleware.
     */
    async signIn({ user, account, profile }) {
      if (account?.provider !== "github") {
        return false;
      }

      const parsed = GithubProfileZ.safeParse(profile);
      if (!parsed.success) {
        console.error("[auth] could not parse GitHub profile during sign-in");
        return false;
      }
      const { id: githubId, login, name, avatar_url: avatarUrl } = parsed.data;

      if (!(await isAllowed(login))) {
        console.error(`[auth] sign-in denied: '${login}' is not allowlisted`);
        return false;
      }

      const db = getDb();
      const now = new Date();
      const [row] = await db
        .insert(users)
        .values({
          githubId,
          login,
          name: name ?? null,
          avatarUrl: avatarUrl ?? null,
          lastLoginAt: now,
        })
        .onConflictDoUpdate({
          target: users.githubId,
          set: {
            login,
            name: name ?? null,
            avatarUrl: avatarUrl ?? null,
            lastLoginAt: now,
          },
        })
        .returning({ id: users.id });

      if (!row) {
        console.error("[auth] users upsert returned no row during sign-in");
        return false;
      }

      // Stash db identity on the user object — the jwt callback receives the
      // same object on this initial sign-in request.
      user.id = String(row.id);
      user.login = login;
      return true;
    },

    /** Persist db user id + login into the JWT on first sign-in. */
    async jwt({ token, user }) {
      if (user) {
        if (user.id) token.userId = user.id;
        if (user.login) token.login = user.login;
      }
      return token;
    },

    /** Expose db user id + login on the session object. */
    async session({ session, token }) {
      if (token.userId) session.user.id = token.userId;
      if (token.login) session.user.login = token.login;
      return session;
    },
  },
});
