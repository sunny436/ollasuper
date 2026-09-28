import { redirect } from "next/navigation";

// Files moved into the File Library. Kept as a redirect so old links and
// bookmarks still land somewhere real. next-international rewrites the locale,
// so the target is the un-prefixed path (see (dashboard)/page.tsx).
export default function FilesPage() {
  redirect("/library");
}
