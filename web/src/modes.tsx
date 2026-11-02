import type { PermissionMode } from "../../shared/types.ts";
import { Menu } from "./Menu.tsx";

// How each permission mode is shown. Order is the menu's order.
export const MODES: Array<{ mode: PermissionMode; label: string; detail: string }> = [
  { mode: "default", label: "Ask", detail: "Ask before editing files or running commands" },
  { mode: "acceptEdits", label: "Accept edits", detail: "Edit files without asking; ask before commands" },
  { mode: "plan", label: "Plan", detail: "Explore and plan only; nothing changes until you approve" },
  { mode: "auto", label: "Auto", detail: "Claude runs what it judges safe and asks when unsure" },
  { mode: "bypassPermissions", label: "Bypass", detail: "Run everything without asking" },
];

// Shift+Tab cycles these, as in Claude Code's terminal. Bypass is never
// one key away.
const CYCLE: PermissionMode[] = ["default", "acceptEdits", "plan", "auto"];

// `modes`: what the session's agent has (Gemini has no Auto); absent: all.
export function nextMode(mode: PermissionMode, modes?: PermissionMode[]): PermissionMode {
  const cycle = modes ? CYCLE.filter((m) => modes.includes(m)) : CYCLE;
  const i = cycle.indexOf(mode);
  return cycle[(i + 1) % cycle.length];
}

export function modeLabel(mode: PermissionMode): string {
  return MODES.find((m) => m.mode === mode)?.label ?? mode;
}

interface Props {
  mode: PermissionMode;
  modes?: PermissionMode[];
  onMode: (mode: PermissionMode) => void;
}

// The permission-mode pill under the message box.
export function ModePicker({ mode, modes, onMode }: Props) {
  return (
    <Menu
      className="mode-picker"
      title="Permission mode (Shift+Tab to switch)"
      buttonClass={`mode-pill mode-${mode}`}
      trigger={<>{modeLabel(mode)} ▾</>}
      items={MODES.filter((m) => !modes || modes.includes(m.mode)).map((m) => ({
        label: m.label,
        detail: m.detail,
        checked: m.mode === mode,
        className: `mode-${m.mode}`,
        onClick: () => onMode(m.mode),
      }))}
    />
  );
}
