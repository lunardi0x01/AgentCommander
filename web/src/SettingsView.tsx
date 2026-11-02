import { useEffect, useState } from "react";
import type { AccessInfo, AppSettings, FolderInfo, ModelOption, PermissionMode } from "../../shared/types.ts";
import { api } from "./api.ts";
import { MODES } from "./modes.tsx";
import { EffortPicker, ModelPicker } from "./ModelPicker.tsx";
import { Page } from "./Page.tsx";
import { Menu } from "./Menu.tsx";

interface Props {
  settings: AppSettings;
  folders: FolderInfo[];
  onSettings: (settings: AppSettings) => void;
  onBack: () => void;
}

// App-wide settings; saved on the server, so every device shares them.
export function SettingsView({ settings, folders, onSettings, onBack }: Props) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Claude Code's model list is the same in every folder; ask the first.
  useEffect(() => {
    if (folders[0]) api.folderDefaults(folders[0].path).then((d) => setModels(d.models), () => {});
  }, [folders[0]?.path]);

  const change = (update: Record<string, unknown>) => {
    setError(null);
    api.updateSettings(update).then(onSettings, (err) => setError(String(err.message ?? err)));
  };

  return (
    <Page title="Settings" subtitle="Shared by all your devices" onBack={onBack} className="settings-page">
      {error && <div className="run-error">{error}</div>}

      <h3 className="page-heading">Chat</h3>
      <label className="setting">
        <input
          type="checkbox"
          checked={settings.hideThinkingAndTools}
          onChange={(e) => change({ hideThinkingAndTools: e.target.checked })}
        />
        <span>
          <span className="setting-name">Hide thinking and tool use</span>
          <span className="setting-detail">
            Show only your messages and Claude's replies; each run of thinking and tool calls becomes one line you can
            open. Permission prompts, plans and questions always show.
          </span>
        </span>
      </label>

      <h3 className="page-heading">Layout</h3>
      <label className="setting">
        <input
          type="checkbox"
          checked={settings.sideOpenByDefault}
          onChange={(e) => change({ sideOpenByDefault: e.target.checked })}
        />
        <span>
          <span className="setting-name">Open notes and queue by default</span>
          <span className="setting-detail">
            Show the third column when the page loads. Otherwise open it from a folder's ⋯ menu, Notes &amp; Queue….
          </span>
        </span>
      </label>

      <h3 className="page-heading">New sessions</h3>
      <p className="setting-detail">What sessions start with. Each chat can still switch under its message box.</p>
      <div className="setting-row">
        <span className="setting-name">Permission mode</span>
        <ModeChoice value={settings.defaultMode} onChange={(mode) => change({ defaultMode: mode ?? null })} allowUnset />
      </div>
      <div className="setting-row">
        <span className="setting-name">Model</span>
        <ModelPicker model={settings.defaultModel ?? "default"} models={models} onModel={(m) => change({ defaultModel: m === "default" ? null : m })} />
      </div>
      <div className="setting-row">
        <span className="setting-name">Effort</span>
        <EffortPicker
          model={settings.defaultModel ?? "default"}
          effort={settings.defaultEffort ?? null}
          models={models}
          onEffort={(effort) => change({ defaultEffort: effort ?? "default" })}
        />
        {!models.length && <span className="muted">…</span>}
      </div>

      <h3 className="page-heading">Queue</h3>
      <div className="setting-row">
        <span>
          <span className="setting-name">Permission mode for queued tasks</span>
          <span className="setting-detail">
            They run while you're away, so Ask would stop each one at its first edit. A task that still needs you waits
            and the queue moves on.
          </span>
        </span>
        <ModeChoice value={settings.queueMode} onChange={(mode) => mode && change({ queueMode: mode })} />
      </div>

      <AccessSection />
    </Page>
  );
}

// Who is signed in and the token for scripts. Browsers get in by Tailscale
// login, so the token matters only for curl and the like.
function AccessSection() {
  const [info, setInfo] = useState<AccessInfo | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.access().then(setInfo, (err) => setError(String(err.message ?? err)));
  }, []);

  const rotate = async () => {
    if (!window.confirm("Make a new token? Scripts using the old one stop working.")) return;
    setError(null);
    try {
      setNewToken((await api.rotateToken()).token);
      setInfo(await api.access());
    } catch (err) {
      setError(String((err as Error).message ?? err));
    }
  };

  const how = !info
    ? "…"
    : info.via === "tailscale"
      ? `${info.login} through Tailscale`
      : info.via === "token"
        ? "the script token"
        : "directly on this computer";

  return (
    <>
      <h3 className="page-heading">Access</h3>
      {error && <div className="run-error">{error}</div>}
      <div className="setting-row">
        <span>
          <span className="setting-name">Signed in as</span>
          <span className="setting-detail">
            Browsers are let in by their Tailscale login: nothing to copy to a new device, and removing a device from your
            tailnet removes its access.
          </span>
        </span>
        <span>{how}</span>
      </div>
      <div className="setting-row">
        <span>
          <span className="setting-name">Allowed logins</span>
          <span className="setting-detail">Change <code>logins</code> in <code>~/.config/agent-commander/config.json</code>.</span>
        </span>
        <span>{info?.logins.length ? info.logins.join(", ") : "none"}</span>
      </div>
      <div className="setting-row">
        <span>
          <span className="setting-name">Token for scripts</span>
          <span className="setting-detail">
            For <code>curl</code> and other tools, sent as <code>Authorization: Bearer</code>. Browsers don't need it.
            {info?.token === "env" && " It is set by AGENT_COMMANDER_TOKEN."}
            {newToken && (
              <>
                {" "}
                New token (shown once): <code>{newToken}</code>
              </>
            )}
          </span>
        </span>
        <button className="secondary-button" disabled={!info || info.token === "env"} onClick={rotate}>
          Make a new token
        </button>
      </div>
    </>
  );
}

// A permission-mode pill; `allowUnset` adds "Claude Code's default".
function ModeChoice({ value, onChange, allowUnset }: { value?: PermissionMode; onChange: (mode: PermissionMode | undefined) => void; allowUnset?: boolean }) {
  const label = value ? (MODES.find((m) => m.mode === value)?.label ?? value) : "Claude Code's default";
  return (
    <Menu
      className="mode-picker"
      title="Permission mode"
      buttonClass={`mode-pill${value ? ` mode-${value}` : ""}`}
      trigger={<>{label} ▾</>}
      items={[
        ...(allowUnset
          ? [{ label: "Claude Code's default", detail: "From your Claude Code settings", checked: !value, onClick: () => onChange(undefined) }]
          : []),
        ...MODES.map((m) => ({ label: m.label, detail: m.detail, checked: m.mode === value, className: `mode-${m.mode}`, onClick: () => onChange(m.mode) })),
      ]}
    />
  );
}
