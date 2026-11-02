import type { EffortLevel, ModelOption } from "../../shared/types.ts";
import { Menu, type MenuEntry } from "./Menu.tsx";

// Claude Code's main choices, listed first; specific older versions follow.
const MAIN_MODELS = ["default", "opus", "sonnet", "fable", "haiku"];

// A model value (alias like "opus", or a full id the process reports).
function findModel(value: string, models: ModelOption[]): ModelOption | undefined {
  return (
    models.find((m) => m.value === value) ??
    models.find((m) => m.resolvedModel === value && m.value !== "default") ??
    models.find((m) => m.resolvedModel === value)
  );
}

export function modelLabel(value: string, models: ModelOption[]): string {
  if (value === "default") {
    // "Default (Opus 5.5)": name what the default currently is.
    const resolved = models.find((m) => m.value === "default")?.resolvedModel;
    const actual = resolved ? findModel(resolved, models.filter((m) => m.value !== "default")) : undefined;
    return actual ? `Default (${actual.displayName})` : "Default";
  }
  return findModel(value, models)?.displayName ?? value;
}

export function ModelPicker({ model, models, onModel }: { model: string; models: ModelOption[]; onModel: (model: string) => void }) {
  const current = findModel(model, models)?.value ?? model;
  const item = (m: ModelOption): MenuEntry => ({
    label: m.value === "default" ? modelLabel("default", models) : m.displayName,
    detail: m.description,
    checked: m.value === current,
    onClick: () => onModel(m.value),
  });
  // Gemini's short list is all main choices.
  const isMain = (m: ModelOption) => MAIN_MODELS.includes(m.value) || m.value.startsWith("gemini");
  const main = models.filter(isMain);
  const others = models.filter((m) => !isMain(m));
  return (
    <Menu
      className="mode-picker"
      title="Model"
      buttonClass="mode-pill"
      trigger={<>{modelLabel(model, models)} ▾</>}
      items={models.length ? [...main.map(item), ...(others.length ? ["divider" as const, ...others.map(item)] : [])] : []}
    />
  );
}

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

// Reasoning effort for models that support it; hidden for ones that don't.
export function EffortPicker(props: {
  model: string;
  effort: EffortLevel | null;
  models: ModelOption[];
  onEffort: (effort: EffortLevel | null) => void;
}) {
  const levels = findModel(props.model, props.models)?.effortLevels;
  if (!levels?.length) return null;
  return (
    <Menu
      className="mode-picker"
      title="Effort: how much the model thinks before answering"
      buttonClass="mode-pill"
      trigger={<>Effort: {props.effort ? EFFORT_LABELS[props.effort] : "Default"} ▾</>}
      items={[
        { label: "Default", detail: "The model's own default", checked: props.effort === null, onClick: () => props.onEffort(null) },
        ...levels.map((level) => ({
          label: EFFORT_LABELS[level],
          checked: props.effort === level,
          onClick: () => props.onEffort(level),
        })),
      ]}
    />
  );
}
