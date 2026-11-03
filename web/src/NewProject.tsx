import { useEffect, useState } from "react";
import type { MachineInfo, NewProjectResult, TemplateInfo } from "../../shared/types.ts";
import { api } from "./api.ts";
import { FolderBrowser } from "./FolderBrowser.tsx";
import { tildePath, uuid } from "./format.ts";

interface Props {
  machine: MachineInfo | null;
  onDone: () => void;
  onOpenSession: (dir: string, id: string) => void;
}

// "No template" keeps the old behaviour: just show an existing folder.
const NONE: TemplateInfo = {
  id: "none",
  name: "No template",
  description: "Just add the folder to the navigator. Nothing is created.",
  public: false,
  files: [],
  publicFiles: [],
};

type Step = "type" | "folder" | "details" | "done";

const setupPrompt = (type: string, description: string, git: boolean) =>
  `I just created this project from the "${type}" template.${description ? ` It is: ${description}.` : ""}\n\n` +
  "Fill in AGENTS.md (commands, rules, what to check before finishing), README.md and the Goal in .project/tasklist.md " +
  "for what this project is. Ask me anything you need to know first. Don't write any code or install anything yet." +
  (git ? " When that's done, make the first git commit of the starter files (check git status first)." : "");

// Choose a project type and a folder, then create the type's starter files.
export function NewProject({ machine, onDone, onOpenSession }: Props) {
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [step, setStep] = useState<Step>("type");
  const [template, setTemplate] = useState<TemplateInfo>(NONE);
  const [dir, setDir] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [git, setGit] = useState(true);
  const [setup, setSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NewProjectResult | null>(null);

  useEffect(() => {
    api.templates().then((list) => setTemplates([...list, NONE]), (err) => setError(String(err.message ?? err)));
  }, []);

  const pickType = (t: TemplateInfo) => {
    setTemplate(t);
    setIsPublic(t.public);
    setStep("folder");
  };

  const pickFolder = (picked: string) => {
    setDir(picked);
    setName(picked.split("/").pop() ?? "");
    setError(null);
    if (template.id === "none") void create(picked);
    else setStep("details");
  };

  const create = async (target = dir) => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createProject({
        dir: target,
        type: template.id,
        name,
        description,
        public: isPublic,
        git,
      });
      setResult(created);
      setStep("done");
      if (setup && template.id !== "none") {
        const id = uuid();
        try {
          await api.sendMessage(id, created.dir, setupPrompt(template.name, description, git), {}, true);
          onOpenSession(created.dir, id);
        } catch (err) {
          setError(`The project was created, but the setup session didn't start: ${String((err as Error).message ?? err)}`);
        }
      }
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="picker">
      <div className="picker-head">
        <div className="picker-title">
          New Project <span className="muted">· {{ type: "choose a type", folder: "choose a folder", details: "details", done: "done" }[step]}</span>
        </div>
        <button className="text-button" onClick={onDone}>
          {step === "done" ? "Done" : "Cancel"}
        </button>
      </div>
      {error && <div className="nav-error">{error}</div>}

      {step === "type" && (
        <ul className="picker-list">
          {!templates && !error && <li className="muted pad">Loading…</li>}
          {templates?.map((t) => (
            <li key={t.id}>
              <button className="type-card" onClick={() => pickType(t)}>
                <span className="picker-name">{t.name}</span>
                <span className="type-desc">{t.description}</span>
                {t.files.length > 0 && <span className="type-files">{[...t.files, ...t.publicFiles].join(" · ")}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {step === "folder" && (
        <>
          <div className="browse-row">
            <span className="browse-open muted">{template.name}: select the project's folder</span>
            <button className="text-button" onClick={() => setStep("type")}>
              Back
            </button>
          </div>
          <FolderBrowser machine={machine} onPick={pickFolder} />
        </>
      )}

      {step === "details" && (
        <form
          className="new-project-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="muted">
            {template.name} in {tildePath(dir, machine?.home)}. Files that already exist are kept.
          </div>
          <label>
            Name
            <input className="picker-filter" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <label>
            One-line description
            <input className="picker-filter" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="check-row">
            <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
            Public repository{template.publicFiles.length > 0 && ` (adds ${template.publicFiles.join(", ")}; keeps .claude/ out of git)`}
          </label>
          <label className="check-row">
            <input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} />
            Start a git repository
          </label>
          <label className="check-row">
            <input type="checkbox" checked={setup} onChange={(e) => setSetup(e.target.checked)} />
            Start a Claude session to fill in AGENTS.md and README (uses your usage)
          </label>
          <div className="dialog-actions">
            <button type="button" className="text-button" onClick={() => setStep("folder")}>
              Back
            </button>
            <button className="secondary-button" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create project"}
            </button>
          </div>
        </form>
      )}

      {step === "done" && result && (
        <div className="new-project-form">
          <div>
            {template.id === "none" ? "Added " : "Created "}
            <code>{tildePath(result.dir, machine?.home)}</code>
            {result.git && ", with a git repository"}.
          </div>
          {result.created.length > 0 && <div className="type-files">{result.created.join(" · ")}</div>}
          {result.skipped.length > 0 && <div className="muted">Left alone because they already existed: {result.skipped.join(", ")}</div>}
          <div className="dialog-actions">
            <button className="secondary-button" onClick={onDone}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
