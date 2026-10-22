import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { safeNext } from "@/lib/ui/format";
import { getCurrentUser } from "@/server/context";

export const metadata: Metadata = { title: "Create account" };

export default async function RegisterPage(props: PageProps<"/register">) {
  const sp = await props.searchParams;
  const next = safeNext(sp.next);
  if (await getCurrentUser()) redirect(next);

  return (
    <div className="container-page flex justify-center py-12 sm:py-20">
      <div className="w-full max-w-md">
        <h1 className="mb-2 text-center text-3xl font-bold tracking-tight">Create your account</h1>
        <p className="mb-8 text-center text-sm text-muted">Book seats in seconds and keep all your tickets in one place.</p>
        <AuthForm mode="register" next={next} />
      </div>
    </div>
  );
}
