"use client";

/**
 * Mode + option controls. Sacred-screen rule (docs/DESIGN.md §7): this bar
 * fades out on the first keystroke and returns on completion — TypingTest
 * controls visibility via the `visible` prop rather than this component
 * hiding itself, so the fade is one obvious switch, not scattered state.
 */

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { TestConfig, TestMode } from "@/lib/types";
import { cn } from "@/lib/utils";

const MODES: { value: TestMode; label: string }[] = [
  { value: "time", label: "time" },
  { value: "words", label: "words" },
  { value: "quote", label: "quote" },
  { value: "zen", label: "zen" },
];

const TIME_OPTIONS = ["15", "30", "60", "120"];
const WORD_OPTIONS = ["10", "25", "50", "100"];

type TestConfigBarProps = {
  config: TestConfig;
  onConfigChange: (config: TestConfig) => void;
  onRestart: () => void;
  visible: boolean;
};

export function TestConfigBar({
  config,
  onConfigChange,
  onRestart,
  visible,
}: TestConfigBarProps) {
  const settingOptions = config.mode === "time" ? TIME_OPTIONS : WORD_OPTIONS;

  return (
    <div
      className={cn(
        "label-type flex flex-wrap items-center justify-center gap-4 transition-opacity duration-200",
        visible ? "opacity-100" : "pointer-events-none opacity-0"
      )}
      aria-hidden={!visible}
    >
      <div className="flex items-center gap-1 rounded-md bg-chassis p-1 ring-1 ring-grid">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            tabIndex={visible ? 0 : -1}
            onClick={() => onConfigChange({ ...config, mode: m.value })}
            className={cn(
              "label-type rounded px-2 py-1 transition-colors",
              config.mode === m.value
                ? "bg-trace text-background"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      {(config.mode === "time" || config.mode === "words") && (
        <div className="flex items-center gap-1 rounded-md bg-chassis p-1 ring-1 ring-grid">
          {settingOptions.map((opt) => (
            <button
              key={opt}
              type="button"
              tabIndex={visible ? 0 : -1}
              onClick={() => onConfigChange({ ...config, modeSetting: opt })}
              className={cn(
                "label-type rounded px-2 py-1 transition-colors",
                config.modeSetting === opt
                  ? "bg-trace text-background"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      <label className="flex items-center gap-1.5">
        <Switch
          checked={config.punctuation}
          onCheckedChange={(checked: boolean) =>
            onConfigChange({ ...config, punctuation: checked })
          }
          tabIndex={visible ? 0 : -1}
        />
        <span>punctuation</span>
      </label>

      <label className="flex items-center gap-1.5">
        <Switch
          checked={config.numbers}
          onCheckedChange={(checked: boolean) =>
            onConfigChange({ ...config, numbers: checked })
          }
          tabIndex={visible ? 0 : -1}
        />
        <span>numbers</span>
      </label>

      <Button
        type="button"
        variant="outline"
        size="sm"
        tabIndex={visible ? 0 : -1}
        onClick={onRestart}
      >
        restart
      </Button>
    </div>
  );
}
