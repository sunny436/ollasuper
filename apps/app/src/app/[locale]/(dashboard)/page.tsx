import { redirect } from "next/navigation";

// The dashboard home is /chat. Kept inside the (dashboard) route group so it
// shares the shell rather than becoming a bare top-level redirect.
// next-international uses urlMappingStrategy: "rewrite", so the target is the
// un-prefixed path — the locale segment is a rewrite, not a real URL.
export default function RootPage() {
  redirect("/chat");
}
