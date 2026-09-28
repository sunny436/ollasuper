import { redirect } from "next/navigation";

// Settings → Files is now the File Library. A redirect keeps old links working.
export default function SettingsFilesPage() {
  redirect("/library");
}
