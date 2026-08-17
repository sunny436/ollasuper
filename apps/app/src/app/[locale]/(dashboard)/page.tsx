import { redirect } from "next/navigation";

// The dashboard home is /chat. This sits inside the (dashboard) route group on
// purpose: layout.tsx runs first, so the onboarding gate still applies before we
// forward. next-international uses urlMappingStrategy: "rewrite", so the target
// is the un-prefixed path — the locale segment is a rewrite, not a real URL.
export default function RootPage() {
  redirect("/chat");
}
