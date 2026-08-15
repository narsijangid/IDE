import type { SessionSnapshot } from './types';

export class SessionState {
  readonly snapshot: SessionSnapshot;
  private edited = new Set<string>();

  constructor(task: string) {
    this.snapshot = {
      task,
      plan: '',
      relevantFiles: [],
      decisions: [],
      constraints: [],
      changes: [],
      validation: '',
      unresolved: [],
      searchesDone: [],
      filesRead: [],
    };
  }

  noteSearch(query: string) {
    addUnique(this.snapshot.searchesDone, query, 24);
  }

  noteRead(filePath: string) {
    addUnique(this.snapshot.filesRead, filePath, 40);
    addUnique(this.snapshot.relevantFiles, filePath, 24);
  }

  noteEdit(filePath: string) {
    this.edited.add(filePath);
    addUnique(this.snapshot.changes, filePath, 40);
  }

  noteDecision(text: string) {
    addUnique(this.snapshot.decisions, text, 12);
  }

  noteConstraint(text: string) {
    addUnique(this.snapshot.constraints, text, 12);
  }

  setPlan(plan: string) {
    this.snapshot.plan = plan.slice(0, 800);
  }

  setValidation(text: string) {
    this.snapshot.validation = text.slice(0, 400);
  }

  renderForTurn(iteration: number): string | undefined {
    if (iteration < 2) return undefined;
    const s = this.snapshot;
    const lines = [
      '# SESSION STATE (do not re-fetch unless files changed)',
      `TASK: ${s.task.slice(0, 300)}`,
      s.plan ? `CURRENT PLAN: ${s.plan}` : '',
      s.relevantFiles.length ? `RELEVANT FILES:\n- ${s.relevantFiles.slice(0, 16).join('\n- ')}` : '',
      s.searchesDone.length ? `SEARCHES ALREADY DONE:\n- ${s.searchesDone.slice(0, 16).join('\n- ')}` : '',
      s.filesRead.length ? `FILES ALREADY READ: ${s.filesRead.slice(0, 20).join(', ')}` : '',
      s.changes.length ? `CURRENT CHANGES:\n- ${s.changes.slice(0, 16).join('\n- ')}` : '',
      s.decisions.length ? `IMPORTANT DECISIONS:\n- ${s.decisions.slice(0, 8).join('\n- ')}` : '',
      s.constraints.length ? `KNOWN CONSTRAINTS:\n- ${s.constraints.slice(0, 8).join('\n- ')}` : '',
      s.validation ? `VALIDATION STATUS: ${s.validation}` : '',
      'Do not repeat identical search/read calls. Edit when evidence is sufficient.',
    ].filter(Boolean);
    return lines.join('\n');
  }
}

function addUnique(list: string[], value: string, max: number) {
  const v = value.trim();
  if (!v) return;
  const existing = list.findIndex((item) => item.toLowerCase() === v.toLowerCase());
  if (existing >= 0) {
    list.splice(existing, 1);
  }
  list.push(v);
  if (list.length > max) list.shift();
}
