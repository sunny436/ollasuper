/**
 * The Library owns the whole viewport beside the rail, like Projects and
 * Scheduled (no ChatShell: the page has no send path of its own). The rail is
 * mounted once by (workspace)/layout.tsx. min-h-0 on every ancestor of the
 * scroller, or flexbox lets the content push the container taller.
 */
export default function LibraryLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-0 w-full flex-1 overflow-hidden">{children}</div>;
}
