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
 *
 * It comes BEFORE AuthPanel, and the order matters. AuthPanel toasts from its
 * mount effect ("signed out because your account was used on another device"),
 * sibling effects run in order, and sonner does not replay a toast raised before
 * its Toaster subscribed. With the Toaster second, that notice was raised into
 * nothing — measured on production: flag set, flag consumed, no toast.
 */
export default function Page() {
  return (
    <>
      <Toaster richColors position="top-right" />
      <AuthPanel />
    </>
  );
}
