import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { safeNext } from "@/lib/ui/format";
import { getCurrentUser } from "@/server/context";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage(props: PageProps<"/login">) {
  const sp = await props.searchParams;
  const next = safeNext(sp.next);
  if (await getCurrentUser()) redirect(next);

  return (
    <div className="container-page flex justify-center py-12 sm:py-20">
      <div className="w-full max-w-md">
        <h1 className="mb-2 text-center text-3xl font-bold tracking-tight">Welcome back</h1>
        <p className="mb-8 text-center text-sm text-muted">Sign in to hold seats and manage your tickets.</p>
        <AuthForm mode="login" next={next} />
      </div>
    </div>
  );
}
