import { useRef, useState } from "react";

interface Props {
  initial: string;
  onSave: (title: string) => Promise<void>;
  onClose: () => void; // after a save, or on cancel
  className?: string;
}

// Inline editor for a session title. Enter or leaving the field saves,
// Escape cancels; an unchanged or empty title just closes it.
export function TitleInput({ initial, onSave, onClose, className }: Props) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter, Escape and blur can all fire for one edit; only the first counts.
  const settled = useRef(false);

  const save = async () => {
    if (settled.current) return;
    settled.current = true;
    const next = draft.trim();
    if (!next || next === initial) return onClose();
    setSaving(true);
    try {
      await onSave(next);
      onClose();
    } catch (err) {
      settled.current = false; // let them fix it and try again
      setError(String((err as Error).message ?? err));
      setSaving(false);
    }
  };

  const cancel = () => {
    settled.current = true;
    onClose();
  };

  return (
    <div className={`title-edit${className ? ` ${className}` : ""}`}>
      <input
        className="title-input"
        value={draft}
        disabled={saving}
        autoFocus
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") cancel();
        }}
      />
      {error && <span className="title-error">{error}</span>}
    </div>
  );
}
