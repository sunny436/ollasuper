export function MessageSkeleton({ align = "left" }: { align?: "left" | "right" }) {
  return (
    <div className={`my-5 ${align === "right" ? "flex justify-end" : ""}`}>
      <div className={align === "right" ? "w-2/3" : "w-full"}>
        <div className="h-3 w-1/3 animate-pulse rounded bg-primary/5" />
        <div className="mt-2 h-3 w-full animate-pulse rounded bg-primary/5" />
        <div className="mt-2 h-3 w-4/5 animate-pulse rounded bg-primary/5" />
      </div>
    </div>
  );
}
