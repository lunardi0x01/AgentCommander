import { useState } from "react";
import type { BackendId, DraftBlock, PermissionMode, PermissionRequest, RunState } from "../../shared/types.ts";
import { Markdown } from "./Markdown.tsx";
import { ChevronIcon } from "./icons.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { summarize, ToolInput } from "./ToolCall.tsx";
import { Speaker, stepsLabel } from "./Message.tsx";

interface Props {
  run: RunState;
  savedUuids: Set<string>; // assistant blocks already loaded from the transcript
  hideTools?: boolean; // collapse thinking and tool calls (a setting)
  continues?: boolean; // the last saved message is the assistant's: no second header
  backend?: BackendId;
  onAnswer: (toolUseId: string, allow: boolean, mode?: PermissionMode, answers?: Record<string, string>) => Promise<void>;
}

// What the transcript doesn't show yet: the reply being streamed, permission
// requests waiting for an answer, and a failed turn's error.
export function LiveTurn({ run, savedUuids, hideTools, continues, backend, onAnswer }: Props) {
  // A finished block is dropped once its saved version has loaded.
  const draft = run.draft.filter((b) => !(b.uuid && savedUuids.has(b.uuid)));
  const busy = run.status === "working" || run.status === "starting";

  return (
    <div className="live-turn">
      {draft.length > 0 && (
        <div className="message assistant">
          {!continues && <Speaker who="assistant" backend={backend} />}
          {hideTools
            ? groupDraft(draft).map((g, i) => (Array.isArray(g) ? <DraftSteps key={i} blocks={g} /> : <DraftView key={i} block={g} />))
            : draft.map((block, i) => <DraftView key={i} block={block} />)}
        </div>
      )}
      {run.permissions.map((p) =>
        p.toolName === "ExitPlanMode" ? (
          <PlanCard key={p.toolUseId} request={p} onAnswer={onAnswer} />
        ) : p.toolName === "AskUserQuestion" ? (
          <QuestionCard key={p.toolUseId} request={p} onAnswer={onAnswer} />
        ) : (
          <PermissionCard key={p.toolUseId} request={p} onAnswer={onAnswer} />
        ),
      )}
      {busy && draft.length === 0 && run.permissions.length === 0 && <div className="turn-working">Working…</div>}
      {run.error && <div className="run-error">{run.error}</div>}
    </div>
  );
}

// Runs of thinking and tool blocks, shown as one line while hidden.
function groupDraft(blocks: DraftBlock[]): Array<DraftBlock | DraftBlock[]> {
  const out: Array<DraftBlock | DraftBlock[]> = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (b.type !== "text" && Array.isArray(last)) last.push(b);
    else out.push(b.type === "text" ? b : [b]);
  }
  return out;
}

function DraftSteps({ blocks }: { blocks: DraftBlock[] }) {
  const working = blocks.some((b) => !b.done);
  return (
    <div className="steps">
      <span className="disclosure">
        <ChevronIcon open={false} /> {stepsLabel(blocks.some((b) => b.type === "thinking"), blocks.filter((b) => b.type === "tool").length, working)}
      </span>
    </div>
  );
}

function DraftView({ block }: { block: DraftBlock }) {
  if (block.type === "text") return <Markdown text={block.text} />;
  if (block.type === "thinking") {
    return (
      <div className="thinking">
        <span className="disclosure">
          <ChevronIcon open={false} /> {block.done ? "Thinking" : "Thinking…"}
        </span>
      </div>
    );
  }
  return (
    <div className="tool pending">
      <div className="tool-header">
        <ChevronIcon open={false} />
        <span className="tool-name">{block.name}</span>
        <span className="tool-summary">{block.done ? summarize(block.name ?? "", parseInput(block.text)) : "preparing…"}</span>
      </div>
    </div>
  );
}

// A finished tool block's input is complete JSON.
function parseInput(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function PermissionCard({ request, onAnswer }: { request: PermissionRequest; onAnswer: Props["onAnswer"] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (allow: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await onAnswer(request.toolUseId, allow);
    } catch (err) {
      setError(String((err as Error).message ?? err));
      setBusy(false);
    }
  };

  const summary = summarize(request.toolName, request.input);
  return (
    <div className="permission-card">
      <div className="permission-title">{request.title ?? `Allow ${request.toolName}?`}</div>
      {(request.description || request.reason) && (
        <div className="permission-reason">{request.description ?? request.reason}</div>
      )}
      <div className="permission-tool">
        <span className="tool-name">{request.toolName}</span>
        {summary && <span className="tool-summary">{summary}</span>}
      </div>
      <ToolInput name={request.toolName} input={request.input} />
      <div className="permission-actions">
        <button className="primary-button" disabled={busy} onClick={() => answer(true)}>
          Allow
        </button>
        <button className="secondary-button" disabled={busy} onClick={() => answer(false)}>
          Deny
        </button>
        {error && <span className="title-error">{error}</span>}
      </div>
    </div>
  );
}

// The agent has finished planning (in plan mode) and asks to start working.
function PlanCard({ request, onAnswer }: { request: PermissionRequest; onAnswer: Props["onAnswer"] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = typeof request.input.plan === "string" ? request.input.plan : "";

  const answer = async (allow: boolean, mode?: PermissionMode) => {
    setBusy(true);
    setError(null);
    try {
      await onAnswer(request.toolUseId, allow, mode);
    } catch (err) {
      setError(String((err as Error).message ?? err));
      setBusy(false);
    }
  };

  return (
    <div className="permission-card plan-card">
      <div className="permission-title">Ready to start on this plan?</div>
      {plan && (
        <div className="plan-body">
          <Markdown text={plan} />
        </div>
      )}
      <div className="permission-actions">
        <button className="primary-button" disabled={busy} onClick={() => answer(true, "acceptEdits")}>
          Approve, auto-accept edits
        </button>
        <button className="secondary-button" disabled={busy} onClick={() => answer(true, "default")}>
          Approve, ask before edits
        </button>
        <button className="secondary-button" disabled={busy} onClick={() => answer(false)}>
          Keep planning
        </button>
        {error && <span className="title-error">{error}</span>}
      </div>
    </div>
  );
}
