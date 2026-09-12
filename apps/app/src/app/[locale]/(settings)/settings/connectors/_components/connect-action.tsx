"use client";

import { Button } from "@v1/ui/button";
import { STATE } from "../_lib/copy";
import type { ConnectorView } from "../_lib/dto";
import { isActionable } from "../_lib/state";

/**
 * The primary button. Its label comes from the state, never from a guess.
 *
 * §15 forbids a generic "Enable" that hides what is actually happening, and
 * §181 fixes the vocabulary — Connect, Reconnect, Retry, and nothing else. Both
 * fall out of reading the label from `STATE`: there is no branch here that
 * could invent a synonym.
 *
 * NO BUTTON IS RENDERED FOR BLOCKED OR UNSUPPORTED. A disabled button invites a
 * user to look for the thing that would enable it; for a policy refusal there
 * is no such thing, and §38 specifically forbids offering a way past one. So
 * `isActionable` returns false and this renders nothing at all.
 */
export function ConnectAction({
  view,
  onRun,
  className = "",
}: {
  view: ConnectorView;
  onRun: (view: ConnectorView) => void;
  className?: string;
}) {
  const label = STATE[view.state].action;
  if (!label || !isActionable(view.state)) return null;

  const busy = view.state === "CONNECTING";
  return (
    <Button
      size="sm"
      variant={view.state === "NOT_CONNECTED" ? "default" : "outline"}
      className={className}
      disabled={busy}
      onClick={() => onRun(view)}
    >
      {label}
    </Button>
  );
}
