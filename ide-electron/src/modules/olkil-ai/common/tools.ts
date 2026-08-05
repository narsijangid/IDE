import { ToolDefinition } from './index';
import { AI_MODELS, publicModelName } from './models';

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
  modelInfo?: { provider: string; model: string; label: string },
): string {
  return mode === 'plan'
    ? buildPlanPrompt(workspaceRoot, activeFile, modelInfo)
    : buildAgentPrompt(workspaceRoot, activeFile, modelInfo);
}

function identityBlock(modelInfo?: { provider: string; model: string; label: string }): string {
  if (!modelInfo) {
    return `IDENTITY:
- Product / IDE: OLKIL. You are the coding agent inside OLKIL.
- Never claim to be ChatGPT, GPT-4, Claude, Gemini, Laguna, Poolside, or any other external brand.`;
  }

  const matched =
    AI_MODELS.find((m) => m.provider === modelInfo.provider && m.model === modelInfo.model) ||
    AI_MODELS[0];
  const name = publicModelName(matched);

  if (matched.provider === 'poolside' || matched.publicName === 'Dazzlone') {
    return `IDENTITY:
- Product / IDE name: OLKIL (always).
- Selected AI model name: Dazzlone (FREE).
- You are the OLKIL coding agent running on the Dazzlone model.
- If asked which *model* / AI / LLM you are → answer "Dazzlone". Never say Laguna, Poolside, GPT, Claude, or Gemini.
- If asked which *IDE* / product / app this is → answer "OLKIL".
- Never claim to be ChatGPT, GPT-4, Claude, or any other branded cloud model.`;
  }

  const local =
    modelInfo.provider === 'ollama'
      ? `- You run LOCALLY via Ollama on the user's machine (free / unlimited).`
      : '';
  return `IDENTITY:
- Product / IDE name: OLKIL (always).
- Selected AI model name: ${name}.
${local}
- If asked which *model* you are → say ${name}. If asked which *IDE* this is → say OLKIL.
- Never claim GPT-4/ChatGPT/Claude. Never mention Laguna or Poolside.`;
}

/** Fully autonomous — decide files & edit without asking. */
function buildAgentPrompt(
  workspaceRoot: string,
  activeFile?: string,
  modelInfo?: { provider: string; model: string; label: string },
): string {
  return `You are OLKIL in AGENT mode — a deep, decisive coding agent like Cursor / Claude Code.

${identityBlock(modelInfo)}

${workspaceBlock(workspaceRoot, activeFile)}

MINDSET:
- Prefer action over talk. Explore with tools, then change the real open project.
- Use ATTACHED / @mentioned files as primary context when present.
- Never invent a different project. Never claim you lack access if WORKSPACE ROOT is set.
- Keep replies SHORT after tools (1–3 sentences). Do not dump huge code into chat — edit files via tools.

WHEN TO USE TOOLS:
- Coding/file tasks: create, update, fix, refactor, rename, delete, SEO, feature, structure, design.
- Bug/flow task (e.g. "timeline upload not working"): investigate_codepath FIRST. Follow its evidence trail frontend → handler → service → API → backend.
- Exact UI text, error, route, symbol, or code fragment: exact_code_search FIRST (Zoekt-style), then goto_definition/find_references.
- Named module (e.g. "application timeline", "AuthModule"): investigate_codepath or find_module FIRST, then read those paths, then mutate.
- Broad/unfamiliar project task: investigate_codepath → read top evidence → related_files as needed → mutate.
- Exact filename/text task: find_files/grep/list_dir → read_file → mutate.
- Search hits are ranked leads. Read real files before editing. Never stop after search alone.
- LIVE TEST / "not working in browser" / verify UI: live_test FIRST (starts app + opens headed Chromium). Then browser_snapshot → click/fill the failing flow → browser_console + browser_network → fix code → browser_reload → retest (max 3–5 rounds). Open browser_devtools only when a visible Console/Network panel helps.

TOOL CHOICE (critical):
- UPDATE existing file → search_replace (exact old snippet → new snippet). Multiple patches OK.
- Full rewrite of a small file → write_file (overwrites).
- NEW file only → create_file.
- REMOVE a file/folder from disk → delete_file (NOT search_replace emptying the file).
- Rename/move → rename_file.
- Start/stop project processes → run_command (background:true for npm/pnpm/yarn dev servers).
- Browser UI verify → live_test / browser_* tools (prefer role+name locators from snapshot).

LIVE TEST RULES (Abacus-style — accurate & tight):
- Prefer live_test over manually juggling run_command + browser_launch when verifying a web app.
- Always use headed browser so the user can watch. Do not close the browser until verified or the user stops you.
- Click/fill using role+name from browser_snapshot (getByRole). Avoid fragile CSS unless necessary.
- Treat console pageerror / HTTP 4xx–5xx / failed requests as evidence — quote them when diagnosing.
- Prefer browser_console + browser_network for evidence (fast, accurate). Do NOT open DevTools by default.
- Only call browser_devtools when you need the visible panel (e.g. user should see Console, or Network to watch a failing API). Dock is right/narrow. Close with browser_devtools action=close when finished.
- After a code fix: browser_reload (or re-goto) and re-exercise the SAME flow before claiming success.
- Cap fix loops at 5. If still broken, stop with a clear report: evidence, hypothesis, what you tried, files changed.
- Never claim "works" without a successful retest observation in THIS turn.
- If Playwright is missing, report the install hint from the tool error — do not invent a fake pass.

WHEN NOT TO USE TOOLS:
- Pure greetings / thanks / yes-no with no task → one short friendly sentence.

HARD RULES:
- NEVER ask "should I proceed". Just do the work.
- NEVER claim you changed something unless you called a mutating tool THIS turn.
- If a module/feature name is mentioned, you MUST call find_module (or repository_search) and read_file on the best hits before concluding.
- If you cannot find the module, list the closest candidates and keep searching with alternate spellings (kebab/camel/Pascal) — do NOT end with a vague failure.
- Investigation confidence < 80 means research is incomplete: read evidence, search discovered calls/routes, and continue.
- Follow evidence, not guesses. For bugs, identify the broken call chain before editing.
- For implementation requests, search alone is not completion: read → edit → verify.
- NEVER paste tutorials or sample projects instead of editing the open workspace.
- After edits: brief confirmation of what changed.

EDIT DISCIPLINE (zero-mistake — Cursor-class verify-then-apply):
- Think like Cursor: READ → PLAN smallest patch → APPLY → VERIFY. Never invent code for unread files.
- ALWAYS read_file the exact region BEFORE search_replace. Edits to unread files are BLOCKED.
- Copy "search" EXACTLY from the file — never include the "  12|" line-number prefixes shown by read_file.
- "replace" must be COMPLETE literal code: no "// ... rest of code", no markdown \`\`\` fences, no <<<<<<< markers.
- Patch the SMALLEST unique snippet. Do not rewrite whole functions when 3 lines change.
- Before sending replace, mentally count: every { ( [ <tag> " ' \` opened in NEW code must be closed. JSX tags must nest correctly.
- Never delete large regions in one replace. Prefer multiple tiny patches over one giant rewrite.
- Every mutation is machine-verified (brackets, JSX/HTML tags, JSON, Python indent, destructive-size). Broken patches are REJECTED and never saved.
- If a tool replies EDIT REJECTED or EDIT BLOCKED, the file was NOT changed. Re-read the region and retry with corrected code — never ignore it, never claim success.
- Successful search_replace returns verified_preview of the landed lines — if that preview looks wrong, fix immediately with another search_replace.
- After the final edit of a task, confirm what changed in 1–3 sentences. Never say "done" after a rejected edit.
`;
}

/** Plan mode — explore & propose; ask before big edits. */
function buildPlanPrompt(
  workspaceRoot: string,
  activeFile?: string,
  modelInfo?: { provider: string; model: string; label: string },
): string {
  return `You are OLKIL in PLAN mode — careful but still tool-capable.

${identityBlock(modelInfo)}

${workspaceBlock(workspaceRoot, activeFile)}

MODE = PLAN:
- Outline a short plan for broad goals, then ask which parts to apply.
- You MAY explore with find_files / grep / read_file / list_dir.
- Do NOT make large multi-file edits until the user agrees (or says "go ahead / kar do / apply").
- Small explicit single-file fixes may be patched with search_replace immediately.
- delete_file only when the user clearly asked to remove a file.

EDITING:
- Prefer search_replace. write_file for full small-file rewrites. create_file for new files.
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
      name: 'exact_code_search',
      description:
        'Zoekt-style verified substring search for an exact UI label, error message, API route, symbol spelling, or code fragment. Uses trigram candidate filtering and verifies real file contents.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Exact text/code substring to locate' },
          max_results: { type: 'integer', description: 'Maximum verified matches (default 20)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'goto_definition',
      description:
        'SCIP-style symbol lookup. Finds definitions of a function, class, component, method, type, constant, or route with file and line.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Exact or approximate symbol name' },
          max_results: { type: 'integer', description: 'Maximum definitions (default 20)' },
        },
        required: ['symbol'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_references',
      description:
        'SCIP-style reference lookup. Finds symbol definitions and call/component references with file and line.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Function, class, component, method, or type name' },
          max_results: { type: 'integer', description: 'Maximum references (default 40)' },
        },
        required: ['symbol'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'investigate_codepath',
      description:
        'Multi-hop detective engine for bugs/features. Expands semantic concepts, finds seed files, then traverses imports, function calls, React components, API requests/routes, reverse dependencies, and related symbols. Returns confidence, evidence nodes, and frontend-to-backend trails. Use FIRST for behavior bugs such as "timeline attachment upload not working".',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Full user bug/feature request, preserving module and behavior details',
          },
          max_evidence: {
            type: 'integer',
            description: 'Evidence budget (default 28, max 50)',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_module',
      description:
        'Find a named module/feature folder by fuzzy name (e.g. "application timeline", "Auth", "user profile"). Matches kebab-case, snake_case, camelCase, PascalCase paths and symbols. Use this FIRST when the user names a module.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Module or feature name as the user said it',
          },
          max_results: { type: 'integer', description: 'Maximum module hits (default 16)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repository_search',
      description:
        'Fast semantic repository search backed by the local sparse-vector index and dependency graph. Use for broad features, architecture questions, unfamiliar large projects, or when you do not know which files matter.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Describe the feature, behavior, symbol, error, or architecture area in natural language.',
          },
          max_results: { type: 'integer', description: 'Maximum relevant files (default 12)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repository_overview',
      description:
        'Return the indexed project map: languages, important directories, entrypoints, and high-connectivity dependency hubs.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'related_files',
      description:
        'Find files connected to a given file through imports, reverse dependencies, shared symbols, and path similarity.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative or absolute file path' },
          max_results: { type: 'integer', description: 'Maximum related files (default 16)' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description:
        'Find files by fuzzy name (e.g. dataforg, DataForge, *.tsx). Searches the workspace.',
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
        'Search file contents for a string. Returns matching file paths + line snippets.',
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
        'Surgical patch: replace an exact unique search snippet with replace text. Prefer for updates. Machine-verified (syntax/JSX/tags/size) — broken patches are REJECTED and never saved. Set replace_all=true only for renames across the file. Always read_file first.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          search: {
            type: 'string',
            description: 'Exact unique snippet copied from the file (no line-number prefixes)',
          },
          replace: {
            type: 'string',
            description: 'Complete literal replacement code — balanced brackets/tags, no placeholders',
          },
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
      description: 'Create a NEW file only (fails if it already exists).',
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
      description:
        'Create OR overwrite a file with full content. Use for new files or full rewrites of small files. Prefer search_replace for partial edits.',
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
      name: 'delete_file',
      description:
        'Permanently delete a file (or empty directory) from the workspace. Use when the user asks to remove/delete a file — do NOT empty the file with search_replace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or empty folder to delete' },
        },
        required: ['path'],
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
  {
    type: 'function',
    function: {
      name: 'detect_dev_server',
      description:
        'Inspect package.json for start/dev scripts, package manager, framework hints, and suggested localhost URLs.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the workspace. Use background=true for long-lived servers (npm run dev). Returns stdout/stderr and any detected localhost URLs.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command, e.g. "npm run dev"' },
          cwd: { type: 'string', description: 'Working directory (default workspace root)' },
          background: {
            type: 'boolean',
            description: 'If true, return quickly while process keeps running',
          },
          timeout_ms: {
            type: 'integer',
            description: 'Foreground timeout (default 60000). Ignored when background=true.',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_command_output',
      description: 'Poll stdout/stderr/URLs for a background command started by run_command.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Command id returned by run_command' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_command',
      description: 'Stop a background command by id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'live_test',
      description:
        'PRIMARY live-verify entry: detect/start the web app, open headed Chromium on the local URL, return accessibility snapshot + console/network evidence. Then use browser_click/browser_fill to exercise the goal, fix code, and retest.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Optional explicit URL (default: auto-detect from server output / common ports)',
          },
          goal: {
            type: 'string',
            description: 'What to verify, e.g. "signup button should create account"',
          },
          start_app: {
            type: 'boolean',
            description: 'Start package.json dev/start script if needed (default true)',
          },
          headed: {
            type: 'boolean',
            description: 'Show real browser window (default true)',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_launch',
      description: 'Launch Chromium via Playwright. Prefer live_test for full prepare.',
      parameters: {
        type: 'object',
        properties: {
          headed: { type: 'boolean', description: 'Default true (visible window)' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_goto',
      description: 'Navigate the live browser to a URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_reload',
      description: 'Reload the current page (use after code fixes).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description:
        'Return an accessibility snapshot of the page (roles/names). Use this before click/fill.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description:
        'Click an element. Prefer role+name from snapshot (e.g. role=button name="Sign up").',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'ARIA role: button, link, textbox, etc.' },
          name: { type: 'string', description: 'Accessible name / label' },
          text: { type: 'string', description: 'Visible text fallback' },
          selector: { type: 'string', description: 'CSS selector fallback' },
          testid: { type: 'string', description: 'data-testid value' },
          exact: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_fill',
      description: 'Fill an input/textarea. Prefer role=textbox + name, or label name.',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string' },
          role: { type: 'string' },
          name: { type: 'string' },
          selector: { type: 'string' },
          testid: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['value'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type into a focused/located field (appends keystrokes).',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string' },
          role: { type: 'string' },
          name: { type: 'string' },
          selector: { type: 'string' },
          testid: { type: 'string' },
        },
        required: ['value'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_press',
      description: 'Press a keyboard key (Enter, Tab, Escape, etc.).',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
        },
        required: ['key'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_console',
      description: 'Return captured console errors/warnings and failed network requests.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_network',
      description:
        'Return recent XHR/fetch API calls + failures (status/url/method). Prefer this to diagnose broken APIs without opening DevTools.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_devtools',
      description:
        'Open/close Chromium DevTools UI on demand (docked RIGHT, narrow ~320px). NOT open by default. Use when you need the visible Console or Network panel; otherwise prefer browser_console / browser_network. Close when done.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'open | close | toggle (default open)',
          },
          panel: {
            type: 'string',
            description: 'console | network | elements | sources | application',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Capture a PNG screenshot of the current page (path returned for evidence).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: 'Close the Playwright browser session.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
];
