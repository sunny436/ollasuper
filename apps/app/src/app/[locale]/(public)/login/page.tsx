import { AuthPanel } from "@/components/auth/auth-panel";
import { Toaster } from "sonner";

export const metadata = {
  title: "Login",
};

/**
 * Stays a Server Component so `metadata` keeps working — the interactive parts
 * live in AuthPanel, which is the "use client" boundary.
 *
 * <Toaster /> is mounted here on purpose. It was previously only in
 * (dashboard)/layout.tsx, and there is no (public) layout, so every toast() call
 * on this page would have been a silent no-op. Position and richColors match the
 * dashboard so the two halves of the app behave identically.
 */
export default function Page() {
  return (
    <>
      <AuthPanel />
      <Toaster richColors position="top-right" />
    </>
  );
}
