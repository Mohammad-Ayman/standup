/**
 * Dashboard route-group layout — sticky top nav (wordmark, Dashboard / Runs /
 * Settings links, user avatar + sign out) shared by every authenticated page.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { auth, signOut } from "@/auth";

const NAV_LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/runs", label: "Runs" },
  { href: "/settings", label: "Settings" },
] as const;

export default async function DashboardLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  const { login, image } = session.user;

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
          <nav className="flex items-center gap-6">
            <Link
              href="/"
              className="text-base font-semibold tracking-tight text-zinc-900"
            >
              Standup
            </Link>
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-zinc-600 transition-colors hover:text-zinc-900"
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element -- remote avatar host is user-configurable; next/image would need an images allowlist in next.config
              <img
                src={image}
                alt={`${login} avatar`}
                referrerPolicy="no-referrer"
                className="size-7 rounded-full ring-1 ring-zinc-200"
              />
            ) : (
              <span className="flex size-7 items-center justify-center rounded-full bg-zinc-200 text-xs font-semibold uppercase text-zinc-600">
                {login?.slice(0, 1) ?? "?"}
              </span>
            )}
            <span className="hidden text-sm font-medium text-zinc-700 sm:inline">
              {login}
            </span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button
                type="submit"
                className="text-sm text-zinc-500 transition-colors hover:text-zinc-900"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
