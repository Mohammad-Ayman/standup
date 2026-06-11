import { signIn } from "@/auth";

const ERROR_MESSAGES: Record<string, string> = {
  AccessDenied: "Your GitHub account is not on the allowlist.",
  Configuration: "Authentication is misconfigured. Check the server logs.",
  Verification: "The sign-in link is no longer valid. Please try again.",
};

const DEFAULT_ERROR_MESSAGE = "Something went wrong signing you in. Please try again.";

function errorMessage(error: string | undefined): string | null {
  if (!error) return null;
  return ERROR_MESSAGES[error] ?? DEFAULT_ERROR_MESSAGE;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : undefined;
  const rawCallbackUrl =
    typeof params.callbackUrl === "string" ? params.callbackUrl : undefined;
  const message = errorMessage(error);

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm rounded-xl border border-gray-200 p-8 text-center shadow-sm">
        <h1 className="text-3xl font-semibold">Standup</h1>
        <p className="mt-2 text-gray-500">Your issues, planned by daybreak.</p>

        {message ? (
          <p
            role="alert"
            className="mt-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {message}
          </p>
        ) : null}

        <form
          className="mt-8"
          action={async () => {
            "use server";
            // Only honor same-app relative callback URLs (no open redirects).
            const redirectTo =
              rawCallbackUrl &&
              rawCallbackUrl.startsWith("/") &&
              !rawCallbackUrl.startsWith("//")
                ? rawCallbackUrl
                : "/";
            await signIn("github", { redirectTo });
          }}
        >
          <button
            type="submit"
            className="w-full rounded-md bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-700"
          >
            Sign in with GitHub
          </button>
        </form>
      </div>
    </main>
  );
}
