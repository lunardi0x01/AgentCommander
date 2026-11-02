import { useState } from "react";
import type { PermissionMode, PermissionRequest } from "../../shared/types.ts";

interface Option {
  label: string;
  description?: string;
  preview?: string;
}

interface Question {
  question: string;
  header?: string;
  options: Option[];
  multiSelect?: boolean;
  other?: boolean; // false: only the options (Gemini can't take a typed answer)
}

interface Props {
  request: PermissionRequest;
  onAnswer: (toolUseId: string, allow: boolean, mode?: PermissionMode, answers?: Record<string, string>) => Promise<void>;
}

// Claude asks multiple-choice questions (the AskUserQuestion tool). Each
// question takes one option (or several when multi-select) or a typed
// "Other" answer; answers go back keyed by question text, labels joined with
// ", " for multi-select, as Claude Code sends them.
export function QuestionCard({ request, onAnswer }: Props) {
  const questions = (Array.isArray(request.input.questions) ? request.input.questions : []) as Question[];
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));
  const [other, setOther] = useState<string[]>(() => questions.map(() => ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (qi: number, label: string, multi: boolean) =>
    setPicked((prev) =>
      prev.map((labels, i) =>
        i !== qi ? labels : multi ? (labels.includes(label) ? labels.filter((l) => l !== label) : [...labels, label]) : [label],
      ),
    );

  const answerFor = (qi: number) => {
    const typed = other[qi].trim();
    const labels = picked[qi];
    if (questions[qi].multiSelect) return [...labels, ...(typed ? [typed] : [])].join(", ");
    return typed || labels[0] || "";
  };
  const complete = questions.length > 0 && questions.every((_, qi) => answerFor(qi));

  const send = async (allow: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const answers = allow ? Object.fromEntries(questions.map((q, qi) => [q.question, answerFor(qi)])) : undefined;
      await onAnswer(request.toolUseId, allow, undefined, answers);
    } catch (err) {
      setError(String((err as Error).message ?? err));
      setBusy(false);
    }
  };

  return (
    <div className="permission-card question-card">
      {questions.map((q, qi) => {
        const multi = !!q.multiSelect;
        const previewed = q.options.find((o) => o.preview && picked[qi].includes(o.label));
        return (
          <fieldset key={qi} className="question" disabled={busy}>
            <legend>
              {q.header && <span className="question-chip">{q.header}</span>}
              <span className="question-text">{q.question}</span>
              {multi && <span className="question-multi">Pick any</span>}
            </legend>
            {q.options.map((o) => {
              const on = picked[qi].includes(o.label);
              return (
                <label key={o.label} className={`question-option${on ? " on" : ""}`}>
                  <input
                    type={multi ? "checkbox" : "radio"}
                    name={`q-${request.toolUseId}-${qi}`}
                    checked={on}
                    onChange={() => {
                      toggle(qi, o.label, multi);
                      if (!multi) setOther((prev) => prev.map((t, i) => (i === qi ? "" : t)));
                    }}
                  />
                  <span>
                    <span className="question-label">{o.label}</span>
                    {o.description && <span className="question-description">{o.description}</span>}
                  </span>
                </label>
              );
            })}
            {q.other !== false && (
            <input
              className="question-other"
              placeholder="Other: type your own answer"
              value={other[qi]}
              onChange={(e) => {
                const value = e.target.value;
                setOther((prev) => prev.map((t, i) => (i === qi ? value : t)));
                if (!multi && value) setPicked((prev) => prev.map((l, i) => (i === qi ? [] : l)));
              }}
            />
            )}
            {previewed && <pre className="question-preview">{previewed.preview}</pre>}
          </fieldset>
        );
      })}
      <div className="permission-actions">
        <button className="primary-button" disabled={busy || !complete} onClick={() => send(true)}>
          Submit answers
        </button>
        <button className="secondary-button" disabled={busy} onClick={() => send(false)}>
          Skip
        </button>
        {error && <span className="title-error">{error}</span>}
      </div>
    </div>
  );
}
