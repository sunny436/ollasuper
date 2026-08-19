"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@v1/ui/select";
import { cn } from "@v1/ui/utils";
import { Moon, Sun, Sunset } from "lucide-react";
import { useAmbience } from "@/lib/ambience/ambience-provider";

/**
 * The compact ambience control for the dashboard sidebar (the chat header uses
 * the full <AmbienceSlider/>). Both write the same single source of truth via
 * useAmbience — this offers the three named stops as a dropdown so the routes
 * that kept the dashboard shell get a familiar control. Was the Light/Dark/System
 * next-themes switcher; ambience replaced next-themes.
 */
const PRESETS = [
  { value: "day", label: "Daylight", intensity: 0, Icon: Sun },
  { value: "amber", label: "Amber", intensity: 50, Icon: Sunset },
  { value: "midnight", label: "Midnight", intensity: 100, Icon: Moon },
] as const;

function currentPreset(i: number): (typeof PRESETS)[number]["value"] {
  return i < 34 ? "day" : i < 67 ? "amber" : "midnight";
}

export function ThemeSwitcher({ triggerClass }: { triggerClass?: string }) {
  const { intensity, setIntensityAnimated } = useAmbience();
  const value = currentPreset(intensity);
  const active = PRESETS.find((p) => p.value === value) ?? PRESETS[0];
  const Icon = active.Icon;

  return (
    <Select
      value={value}
      onValueChange={(v) => {
        const preset = PRESETS.find((p) => p.value === v);
        if (preset) setIntensityAnimated(preset.intensity);
      }}
    >
      <SelectTrigger
        className={cn(
          "h-6 rounded border-primary/20 bg-secondary !px-2 hover:border-primary/40",
          triggerClass,
        )}
      >
        <div className="flex items-center gap-2">
          <Icon className="h-[14px] w-[14px]" />
          <span className="text-xs font-medium">{active.label}</span>
        </div>
      </SelectTrigger>
      <SelectContent>
        {PRESETS.map((p) => (
          <SelectItem
            key={p.value}
            value={p.value}
            className={`text-sm font-medium ${p.value === value ? "text-primary" : "text-primary/60"}`}
          >
            {p.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
