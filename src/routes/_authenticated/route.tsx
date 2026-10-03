import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useEffect } from "react";
import { getMe } from "@/lib/api/auth";
import { bootShell } from "@shell/index";

// Authentication-first gate: the session token is validated by the Speed API before
// any protected route code, loader or data runs. Unauthenticated → /auth/login.
// Runs in the browser only (ssr: false) because the session lives in the browser.
export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ context, location }) => {
    // Only a positive result is cached client-side; the server re-validates every protected call anyway.
    const cached = context.queryClient.getQueryData<Awaited<ReturnType<typeof getMe>>>(["me"]);
    const me = cached ?? (await getMe());
    if (me) context.queryClient.setQueryData(["me"], me);
    if (!me) throw redirect({ to: "/auth/login", search: { redirect: location.href } as never });
    if (!me.email_verified) {
      context.queryClient.removeQueries({ queryKey: ["me"] });
      throw redirect({ to: "/auth/verify-email" });
    }
    return { me };
  },
  component: AuthenticatedShell,
});

function AuthenticatedShell() {
  const { me, queryClient } = Route.useRouteContext();
  useEffect(() => { void bootShell(queryClient, me.id); }, [queryClient, me.id]);
  return <Outlet />;
}
