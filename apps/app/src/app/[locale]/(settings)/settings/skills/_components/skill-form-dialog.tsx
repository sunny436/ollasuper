"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { Button } from "@v1/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@v1/ui/dialog";
import { Input } from "@v1/ui/input";
import { Textarea } from "@v1/ui/textarea";
import { useMutation } from "convex/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CapabilityPicker } from "./capability-picker";

/**
 * Create or edit ONE custom skill.
 *
 * One dialog for both, because they are one form and one server contract —
 * splitting them would duplicate every field and every limit, and the two would
 * drift. `skill === null` means create.
 *
 * WHAT THIS FORM DELIBERATELY DOES NOT OFFER: code, packages, URLs, credentials,
 * or tool registration. None of them are part of the data model at all, and a
 * skill is declarative guidance — never something that executes.
 *
 * It DOES offer a capability picker, and that is a Phase 8 correction. The
 * control was withheld while the field was inert ("a switch wired to nothing is
 * worse than its absence"). Phase 6 made the runtime read it and nobody closed
 * the loop, so a shipped runtime path was reachable only by calling the API
 * directly. The picker is a CLOSED list from the deployment's own catalogue —
 * see `capability-picker.tsx` for why it is never free text, and why declaring
 * a capability does not grant one.
 *
 * The limits below MIRROR the server; they do not replace it. `skillPolicy.ts`
 * is authoritative and re-validates every field, so a client that skipped this
 * form entirely gains nothing.
 */

const MAX = {
  name: 80,
  description: 200,
  instructions: 4000,
  constraints: 2000,
} as const;

// Mirrors MAX_SKILL_CAPABILITIES in skillPolicy.ts, which is authoritative.
const MAX_CAPABILITIES = 16;

export type EditableSkill = {
  _id: Id<"userSkills">;
  name: string;
  description: string;
  instructions: string;
  constraints: string;
  capabilities: string[];
};

const EMPTY = {
  name: "",
  description: "",
  instructions: "",
  constraints: "",
  capabilities: [] as string[],
};

/** Convex wraps a thrown ConvexError with framing noise; show just the message. */
function readableError(e: unknown, fallback: string): string {
  const data = (e as { data?: unknown })?.data;
  if (typeof data === "string" && data) return data;
  const msg = (e as Error)?.message ?? "";
  const m = /Uncaught ConvexError:\s*(.+?)(\n|$)/.exec(msg);
  return m?.[1] ?? fallback;
}

export function SkillFormDialog({
  open,
  onOpenChange,
  workspaceId,
  skill,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: Id<"workspaces"> | null;
  /** null = create a new skill. */
  skill: EditableSkill | null;
}) {
  const create = useMutation(api.userSkills.create);
  const update = useMutation(api.userSkills.update);

  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed whenever the dialog opens, so editing skill B never shows skill A's
  // text and a cancelled edit never leaks into the next one.
  useEffect(() => {
    if (!open) return;
    setForm(
      skill
        ? {
            name: skill.name,
            description: skill.description,
            instructions: skill.instructions,
            constraints: skill.constraints,
            capabilities: skill.capabilities,
          }
        : EMPTY,
    );
    setError(null);
  }, [open, skill]);

  const set = (k: "name" | "description" | "instructions" | "constraints", v: string) =>
    setForm((p) => ({ ...p, [k]: v }));

  // Trimmed on both sides, so trailing whitespace never enables a save that
  // would send nothing — and never leaves the form reading as unsaved after one.
  const trimmed = {
    name: form.name.trim(),
    description: form.description.trim(),
    instructions: form.instructions.trim(),
    constraints: form.constraints.trim(),
    // Already a closed set from the catalogue; sorted so an unchanged pick in a
    // different click order does not read as a pending edit.
    capabilities: [...form.capabilities].sort(),
  };
  const complete = !!trimmed.name && !!trimmed.instructions;
  const dirty = skill
    ? trimmed.name !== skill.name.trim() ||
      trimmed.description !== skill.description.trim() ||
      trimmed.instructions !== skill.instructions.trim() ||
      trimmed.constraints !== skill.constraints.trim() ||
      trimmed.capabilities.join() !== [...skill.capabilities].sort().join()
    : complete;

  const save = async () => {
    if (!workspaceId || saving || !complete) return;
    setSaving(true);
    setError(null);
    try {
      if (skill) {
        await update({ skillId: skill._id, ...trimmed });
        toast.success("Skill updated");
      } else {
        await create({ workspaceId, ...trimmed });
        toast.success("Skill created");
      }
      onOpenChange(false);
    } catch (e) {
      // Kept open on purpose: the user's text is still the truth, and the
      // server's reason (a limit, a secret it spotted) is worth reading in
      // place rather than losing to a closed dialog.
      setError(readableError(e, "Couldn't save the skill."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Radix portals to document.body, which is OUTSIDE the settings shell's
          `.workspace` subtree — without this the dialog renders against the base
          palette while the page behind it uses the workspace tokens. */}
      <DialogContent className="scrollbar-quiet workspace max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{skill ? "Edit skill" : "New skill"}</DialogTitle>
          <DialogDescription>
            Private to you. The assistant follows this when the task fits — it
            does not change what the assistant is allowed to do.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field
            id="skill-name"
            label="Name"
            hint="What you'll recognise it by."
            value={form.name}
            max={MAX.name}
          >
            <Input
              id="skill-name"
              value={form.name}
              maxLength={MAX.name}
              placeholder="Contract reviewer"
              onChange={(e) => set("name", e.target.value)}
              className="bg-transparent"
            />
          </Field>

          <Field
            id="skill-description"
            label="Description"
            hint="Optional. A short note about when it applies."
            value={form.description}
            max={MAX.description}
          >
            <Input
              id="skill-description"
              value={form.description}
              maxLength={MAX.description}
              placeholder="For reviewing supplier contracts."
              onChange={(e) => set("description", e.target.value)}
              className="bg-transparent"
            />
          </Field>

          <Field
            id="skill-instructions"
            label="Instructions"
            hint="How you want the assistant to approach this kind of task."
            value={form.instructions}
            max={MAX.instructions}
          >
            <Textarea
              id="skill-instructions"
              value={form.instructions}
              maxLength={MAX.instructions}
              placeholder={
                "Read the contract end to end before commenting. Flag every " +
                "ambiguous clause and quote it. Never guess a clause number."
              }
              onChange={(e) => set("instructions", e.target.value)}
              className="min-h-40 resize-y bg-transparent"
            />
          </Field>

          <Field
            id="skill-constraints"
            label="Constraints"
            hint="Optional. Limits you want it to respect."
            value={form.constraints}
            max={MAX.constraints}
          >
            <Textarea
              id="skill-constraints"
              value={form.constraints}
              maxLength={MAX.constraints}
              placeholder="Never speculate about intent. Say so when a clause is missing."
              onChange={(e) => set("constraints", e.target.value)}
              className="min-h-24 resize-y bg-transparent"
            />
          </Field>

          <CapabilityPicker
            value={form.capabilities}
            max={MAX_CAPABILITIES}
            onChange={(capabilities) =>
              setForm((prev) => ({ ...prev, capabilities }))
            }
          />

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="mt-2 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!complete || !dirty || saving || !workspaceId}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : skill ? "Save changes" : "Create skill"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Label + control + live counter. One component so every field counts the same way. */
function Field({
  id,
  label,
  hint,
  value,
  max,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  max: number;
  children: React.ReactNode;
}) {
  // Counted by CODE POINT, matching how the server clamps — a UTF-16 count
  // would tell someone with emoji in their text that they have room they do not.
  const used = [...value].length;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-primary/80">
        {label}
      </label>
      <p className="text-xs text-primary/60">{hint}</p>
      {children}
      <p
        className={`text-right text-[11px] ${
          used > max * 0.9 ? "text-primary/60" : "text-muted-foreground"
        }`}
      >
        {used}/{max}
      </p>
    </div>
  );
}
