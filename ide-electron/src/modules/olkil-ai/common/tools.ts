import { ToolDefinition } from './index';

export type ChatMode = 'agent' | 'plan';

export const DEFAULT_CHAT_MODE: ChatMode = 'agent';

function workspaceBlock(workspaceRoot: string, activeFile?: string): string {
  return `WORKSPACE ROOT: ${workspaceRoot || '(none — ask user to File > Open Folder)'}
ACTIVE FILE: ${activeFile || '(none)'}`;
}

export function buildSystemPrompt(
  mode: ChatMode,
  workspaceRoot: string,
  activeFile?: string,
): string {
  return mode === 'plan'
    ? buildPlanPrompt(workspaceRoot, activeFile)
    : buildAgentPrompt(workspaceRoot, activeFile);
}

/** Fully autonomous — decide files & edit without asking. */
function buildAgentPrompt(workspaceRoot: string, activeFile?: string): string {
  return `You are OLKIL in AGENT mode — a smart coding agent like Cursor.

${workspaceBlock(workspaceRoot, activeFile)}

WHEN TO USE TOOLS / EDIT:
- ONLY when the LATEST user message is a real coding/file task (edit, fix, rename, SEO, add feature, refactor, create file, etc.).
- Then: explore with tools, decide files yourself, APPLY edits with search_replace/create_file/rename_file. Do not ask permission.

WHEN NOT TO USE TOOLS:
- Greetings / small talk / thanks / "hi" / "ok" / "thanks" / yes-no without a new task → reply in 1 short friendly sentence.
- Do NOT call tools. Do NOT edit files. Do NOT continue an older unfinished coding task from chat history unless the latest message clearly asks you to continue that work.

HARD RULES FOR REAL TASKS:
- NEVER ask "let me know", "should I proceed", "would you like me to".
- NEVER claim you changed a file unless you actually called search_replace / create_file / rename_file THIS turn.
- Do what the user asked — do not invent a different goal (e.g. if they say hi, do not start SEO edits).
- After real edits: 1–3 short sentences confirming what changed.

EDITING:
- NEVER rewrite whole files. Use search_replace with exact snippets.
- Prefer replace_all=true for string renames. Read only needed lines before patching.
`;
}

/** Plan mode — explore & propose; ask before big edits (previous default style). */
function buildPlanPrompt(workspaceRoot: string, activeFile?: string): string {
  return `You are OLKIL in PLAN mode — a careful coding assistant.

${workspaceBlock(workspaceRoot, activeFile)}

MODE = PLAN:
- Think with the user. For broad goals, first outline a short plan (bullet points) and ask which parts to apply.
- You MAY use find_files / grep / read_file / list_dir to explore.
- Do NOT make large multi-file edits until the user agrees with the plan (or clearly says "go ahead / kar do / apply").
- Small, obvious single-file fixes the user explicitly named are OK to patch immediately with search_replace.
- Be concise. Prefer clarifying questions when the target file or desired outcome is ambiguous.
- After tools succeed, summarize briefly.

EDITING (when approved):
- NEVER rewrite whole files. Use search_replace with exact snippets.
- create_file only for new files. rename_file for filename moves.
`;
}

/** @deprecated use buildSystemPrompt */
export function buildAgentSystemPrompt(workspaceRoot: string, activeFile?: string): string {
  return buildSystemPrompt('agent', workspaceRoot, activeFile);
}

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_active_file',
      description: 'Get the currently focused editor file path + short numbered preview.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description:
        'Find files by fuzzy name (e.g. dataforg, DataForge, *.tsx). Searches the workspace. USE THIS when the user names a file vaguely — or when AGENT mode needs to discover targets.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Filename fragment or glob-like query, case-insensitive',
          },
          max_results: { type: 'integer', description: 'Max results (default 30)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search file contents for a string (e.g. DataForge, meta description, title). Returns matching file paths + line snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to search for' },
          max_results: { type: 'integer', description: 'Max matches (default 40)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file (prefer start_line/end_line). Returns numbered lines.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'integer' },
          end_line: { type: 'integer' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_replace',
      description:
        'Patch a file: replace exact search text with replace text. For title/string renames set replace_all=true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          search: { type: 'string' },
          replace: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['path', 'search', 'replace'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rename_file',
      description: 'Rename/move a file on disk (changes the filename, not file contents).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Current file path' },
          new_path: { type: 'string', description: 'New file path' },
        },
        required: ['path', 'new_path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Create a NEW file only (fails if it already exists). Do not use to rewrite existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Alias of create_file — create a NEW file only.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and folders in a directory (relative to workspace or absolute).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (default workspace root)' },
        },
        additionalProperties: false,
      },
    },
  },
];
