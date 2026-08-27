"use client";

import { api } from "@v1/backend/convex/_generated/api";
import { Button } from "@v1/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@v1/ui/select";
import { ConfirmButton } from "@/components/confirm-button";
import { useWorkspace } from "@/lib/useWorkspace";
import { useAction, useMutation, useQuery } from "convex/react";
import { AlertTriangle, CheckCircle2, PlugZap } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

type Property = {
  kind: string;
  propertyId: string;
  displayName: string;
  permission: string;
};

const GOOGLE_ICON = (
  <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" aria-hidden>
    <path
      fill="#4285F4"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09Z"
    />
    <path
      fill="#34A853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.98.66-2.24 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
    />
    <path
      fill="#FBBC05"
      d="M5.84 14.09a6.6 6.6 0 0 1 0-4.18V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.84Z"
    />
    <path
      fill="#EA4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
    />
  </svg>
);

const CARD = "rounded-2xl border border-border bg-card/60 p-6 backdrop-blur-xl";

export default function ConnectionsPage() {
  const { current } = useWorkspace();
  const router = useRouter();
  const params = useSearchParams();
  const status = useQuery(api.connectors.status, {});
  const beginAuth = useMutation(api.connectors.beginGoogleAuth);
  const confirmConnection = useMutation(api.connectors.confirmConnection);
  const selectProperty = useMutation(api.connectors.selectProperty);
  const listProperties = useAction(api.connectors.listGoogleProperties);
  const disconnect = useAction(api.connectors.disconnect);

  const [busy, setBusy] = useState(false);
  const [props, setProps] = useState<Property[] | null>(null);

  // Handle the OAuth callback return: ?confirm=<accountId> (initiator confirms) or
  // ?error=<reason>. Only the initiating session can promote the connection.
  useEffect(() => {
    const confirmId = params.get("confirm");
    const err = params.get("error");
    if (err) {
      toast.error(`Could not connect Google (${err}).`);
      router.replace("/settings/connections");
      return;
    }
    if (confirmId) {
      confirmConnection({ accountId: confirmId })
        .then((r) => toast.success(`Connected ${r.email}.`))
        .catch(() => toast.error("Could not confirm the connection."))
        .finally(() => router.replace("/settings/connections"));
    }
  }, [params, confirmConnection, router]);

  const loadProps = useCallback(async () => {
    try {
      const r = await listProperties();
      setProps([...(r.gscSites as Property[]), ...(r.ga4Properties as Property[])]);
    } catch {
      toast.error("Could not load your Google properties.");
    }
  }, [listProperties]);

  useEffect(() => {
    if (status?.connected && status.status === "active") void loadProps();
  }, [status?.connected, status?.status, loadProps]);

  const onConnect = async () => {
    if (busy || !current) return;
    setBusy(true);
    try {
      const res = await beginAuth({ workspaceId: current });
      if (!res.configured) {
        toast.error("Google connections are not configured yet.");
        return;
      }
      window.location.href = res.authorizeUrl;
    } catch {
      toast.error("Could not start the connection.");
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    try {
      await disconnect();
      setProps(null);
      toast.success("Disconnected Google.");
    } catch {
      toast.error("Could not disconnect.");
    }
  };

  const onSelect = async (kind: string, propertyId: string) => {
    try {
      await selectProperty({ kind, propertyId });
      toast.success("Property selected.");
    } catch {
      toast.error("Could not select that property.");
    }
  };

  if (status === undefined) return null;

  const gsc = (props ?? []).filter((p) => p.kind === "gsc_site");
  const ga4 = (props ?? []).filter((p) => p.kind === "ga4_property");

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">
          Connections
        </h1>
        <p className="mt-1 text-sm text-primary/55">
          Connect read-only Google data so SEO audits can use your real Search Console
          and Analytics evidence. Your credentials are encrypted and never shared with
          your workspace.
        </p>
      </header>

      <section className={CARD}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            {GOOGLE_ICON}
            <div>
              <div className="text-sm font-semibold text-primary/90">
                Google Search Console &amp; Analytics
              </div>
              {!status.configured ? (
                <div className="text-xs text-primary/50">
                  Not yet available — an administrator must finish setup.
                </div>
              ) : status.connected ? (
                <div className="text-xs text-primary/60">
                  {status.email}
                  {status.status === "needs_reauth" ? (
                    <span className="ml-2 inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-3 w-3" aria-hidden /> reconnect needed
                    </span>
                  ) : (
                    <span className="ml-2 inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" aria-hidden /> connected
                    </span>
                  )}
                </div>
              ) : (
                <div className="text-xs text-primary/50">Not connected.</div>
              )}
            </div>
          </div>
          {status.configured &&
            (status.connected && status.status !== "needs_reauth" ? (
              <ConfirmButton
                label="Disconnect"
                title="Disconnect Google?"
                description="This revokes OllaSuper's read-only access at Google and removes the connection. Your audits will no longer use first-party evidence."
                confirmLabel="Disconnect"
                onConfirm={onDisconnect}
                className="rounded-md border border-border bg-secondary px-2.5 py-1.5 text-xs text-primary/70 hover:bg-primary/5"
              />
            ) : (
              <Button size="sm" onClick={onConnect} disabled={busy || !current}>
                <PlugZap className="mr-1.5 h-4 w-4" aria-hidden />
                {status.connected ? "Reconnect" : "Connect Google"}
              </Button>
            ))}
        </div>

        {status.connected && status.status === "active" && (
          <div className="mt-5 grid gap-4 border-t border-border pt-5 sm:grid-cols-2">
            <PropertyPicker
              label="Search Console property"
              value={status.gscSite ?? ""}
              placeholder={props === null ? "Loading…" : "Select a site"}
              options={gsc}
              onChange={(v) => onSelect("gsc_site", v)}
            />
            <PropertyPicker
              label="Analytics property"
              value={status.ga4Property ?? ""}
              placeholder={props === null ? "Loading…" : "Select a property"}
              options={ga4}
              onChange={(v) => onSelect("ga4_property", v)}
            />
          </div>
        )}
      </section>

      <p className="text-xs text-primary/40">
        Read-only scopes only (Search Console + Analytics). Tokens are encrypted at
        rest and never exposed to the AI model, logs, or downloads.
      </p>
    </div>
  );
}

function PropertyPicker({
  label,
  value,
  placeholder,
  options,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  options: Property[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-primary/60">{label}</span>
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        {/* Radix portals to document.body → needs `workspace` for the glass tokens. */}
        <SelectContent className="workspace">
          {options.map((o) => (
            <SelectItem key={o.propertyId} value={o.propertyId}>
              {o.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
