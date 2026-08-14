"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@v1/ui/dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import { MODELS, modelLabel } from "../_lib/models";

export function ModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Choose model"
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-primary/50 transition hover:bg-primary/5 hover:text-primary/80 disabled:opacity-40"
        >
          {modelLabel(value)}
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {MODELS.map((m) => (
          <DropdownMenuItem
            key={m.id}
            onSelect={() => onChange(m.id)}
            className="flex items-center justify-between gap-2 text-xs"
          >
            <span className="flex flex-col">
              <span className="text-primary/90">{m.label}</span>
              <span className="text-[10px] text-primary/45">{m.hint}</span>
            </span>
            {value === m.id && <Check className="h-3.5 w-3.5 text-brand-ink" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
