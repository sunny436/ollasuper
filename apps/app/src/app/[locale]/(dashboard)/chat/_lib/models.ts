/**
 * Client-side mirror of ALLOWED_MODELS in convex/chat/authz.ts.
 *
 * The server is the authority — it rejects anything not on its list — this is
 * only for labelling the picker. Keep the ids in sync.
 */
export interface ModelOption {
  id: string;
  label: string;
  hint: string;
}

export const MODELS: ModelOption[] = [
  {
    id: "anthropic/claude-opus-5",
    label: "Opus 5",
    hint: "Most capable",
  },
  {
    id: "anthropic/claude-sonnet-5",
    label: "Sonnet 5",
    hint: "Balanced",
  },
  {
    id: "anthropic/claude-haiku-4.5",
    label: "Haiku 4.5",
    hint: "Fastest",
  },
];

export const DEFAULT_MODEL = "anthropic/claude-opus-5";

export function modelLabel(id: string | null | undefined): string {
  return MODELS.find((m) => m.id === id)?.label ?? "Opus 5";
}
