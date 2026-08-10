import { ToolDefinition } from './index';
import { AI_MODELS, publicModelName } from './models';
import { buildClineStyleSystemPrompt, type ChatMode } from './cline-prompt';

export type { ChatMode };
export const DEFAULT_CHAT_MODE: ChatMode = 'agent';

/**
 * Cline-style system prompt (OLKIL branding). Drives chat agent behavior.
 */
export function buildSystemPrompt(
  mode: ChatMode,
  workspaceRoot: string,
  activeFile?: string,
  modelInfo?: { provider: string; model: string; label: string },
  extraRules?: string,
): string {
  return buildClineStyleSystemPrompt({
    mode,
    workspaceRoot,
    activeFile,
    rules: extraRules,
    identity: identityBlock(modelInfo),
  });
}

function identityBlock(modelInfo?: { provider: string; model: string; label: string }): string {
  if (!modelInfo) {
    return `# Identity
- Product / IDE: OLKIL. You are the coding agent inside OLKIL.
- Never claim to be ChatGPT, GPT-4, Claude, Gemini, Cline, Laguna, Poolside, or any other external brand.`;
  }

  const matched =
    AI_MODELS.find((m) => m.provider === modelInfo.provider && m.model === modelInfo.model) ||
    AI_MODELS[0];
  const name = publicModelName(matched);

  if (matched.provider === 'poolside' || matched.publicName === 'Dazzlone') {
    return `# Identity
- Product / IDE name: OLKIL (always).
- Selected AI model name: Dazzlone (FREE).
- You are the OLKIL coding agent running on the Dazzlone model.
- If asked which *model* / AI / LLM you are → answer "Dazzlone". Never say Laguna, Poolside, GPT, Claude, Gemini, or Cline.
- If asked which *IDE* / product / app this is → answer "OLKIL".
- Never claim to be ChatGPT, GPT-4, Claude, or any other branded cloud model.`;
  }

  const local =
    modelInfo.provider === 'ollama'
      ? `- You run LOCALLY via Ollama on the user's machine (free / unlimited).`
      : '';
  return `# Identity
- Product / IDE name: OLKIL (always).
- Selected AI model name: ${name}.
${local}
- If asked which *model* you are → say ${name}. If asked which *IDE* this is → say OLKIL.
- Never claim GPT-4/ChatGPT/Claude/Cline. Never mention Laguna or Poolside.`;
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
      name: 'update_todos',
      description:
        'Create or update a Cursor-style todo checklist for multi-step work. Call early on non-trivial tasks; mark items in_progress/completed as you go. Replaces the whole list each call.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable id for the item' },
                content: { type: 'string', description: 'Short actionable step' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                },
              },
              required: ['id', 'content', 'status'],
            },
          },
          merge: {
            type: 'boolean',
            description: 'If true, merge by id into the existing list; else replace.',
          },
        },
        required: ['todos'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_diagnostics',
      description:
        'Read IDE linter/TypeScript/ESLint diagnostics (errors & warnings). Call after edits to verify nothing broke. Optional path filter.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional file path to filter' },
          severity: {
            type: 'string',
            enum: ['error', 'warning', 'all'],
            description: 'Default error',
          },
          max_results: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_git_status',
      description:
        'List git/SCM changed files (staged/unstaged) like Cursor @Git. Use before summarizing diffs or committing.',
      parameters: {
        type: 'object',
        properties: {
          max_results: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_selection',
      description: 'Get the current editor selection text + path + line range (Cursor selection context).',
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
        'PRIMARY live-verify entry: detect/start the web app, open headed Chromium on the local URL, return accessibility snapshot + console/network evidence. File choosers auto-upload the newest matching file from Downloads/Desktop. Then use browser_click/browser_fill/browser_upload to exercise the goal, fix code, and retest.',
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
        'Click an element. Prefer role+name from snapshot. File-upload clicks auto-pick the newest matching file from Downloads/Desktop (no OS dialog hang).',
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
      name: 'browser_upload',
      description:
        'Upload a file into a file input / chooser. If path omitted, auto-picks the newest matching file from Downloads/Desktop (image→latest image, pdf→latest pdf). Prefer this or a normal click on Upload — never wait on OS dialogs.',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          name: { type: 'string' },
          text: { type: 'string' },
          selector: { type: 'string', description: 'CSS for input[type=file] or upload button' },
          testid: { type: 'string' },
          value: { type: 'string', description: 'Optional absolute file path; else auto-pick' },
          kind: {
            type: 'string',
            description: 'image | pdf | document | spreadsheet | any (default inferred)',
          },
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

/** Tools safe to run in parallel within one model step. */
export const READONLY_TOOL_NAMES = new Set([
  'get_active_file',
  'get_diagnostics',
  'get_git_status',
  'get_selection',
  'exact_code_search',
  'goto_definition',
  'find_references',
  'investigate_codepath',
  'find_module',
  'repository_search',
  'repository_overview',
  'related_files',
  'find_files',
  'grep',
  'read_file',
  'list_dir',
  'detect_dev_server',
  'get_command_output',
  'browser_snapshot',
  'browser_console',
  'browser_network',
  'browser_screenshot',
]);

export const MUTATING_TOOL_NAMES = new Set([
  'search_replace',
  'create_file',
  'write_file',
  'rename_file',
  'delete_file',
]);

const ASK_TOOL_NAMES = new Set([
  'get_active_file',
  'get_diagnostics',
  'get_git_status',
  'get_selection',
  'exact_code_search',
  'goto_definition',
  'find_references',
  'investigate_codepath',
  'find_module',
  'repository_search',
  'repository_overview',
  'related_files',
  'find_files',
  'grep',
  'read_file',
  'list_dir',
]);

const EXPLORE_TOOL_NAMES = new Set([
  ...ASK_TOOL_NAMES,
  'update_todos',
]);

const EDIT_TOOL_NAMES = new Set([
  ...EXPLORE_TOOL_NAMES,
  'search_replace',
  'create_file',
  'write_file',
  'rename_file',
  'delete_file',
  'run_command',
  'get_command_output',
  'stop_command',
  'detect_dev_server',
]);

const BROWSER_TOOL_NAMES = new Set([
  ...EDIT_TOOL_NAMES,
  'live_test',
  'browser_launch',
  'browser_goto',
  'browser_reload',
  'browser_snapshot',
  'browser_click',
  'browser_fill',
  'browser_upload',
  'browser_type',
  'browser_press',
  'browser_console',
  'browser_network',
  'browser_devtools',
  'browser_screenshot',
  'browser_close',
]);

/**
 * Cursor-style schema routing: unlock edits as soon as we have a target.
 * Do NOT burn a whole round explore-only when seed files / active file exist.
 */
export function selectAgentTools(opts: {
  mode?: ChatMode;
  liveTest?: boolean;
  madeEdits?: boolean;
  searchCount?: number;
  readCount?: number;
  /** Known targets from index / active editor — allow mutate immediately. */
  hasSeedTargets?: boolean;
}): ToolDefinition[] {
  if (opts.mode === 'ask') {
    return AGENT_TOOLS.filter((t) => ASK_TOOL_NAMES.has(t.function.name));
  }
  if (opts.liveTest) {
    return AGENT_TOOLS.filter((t) => BROWSER_TOOL_NAMES.has(t.function.name));
  }
  const exploring =
    (opts.searchCount || 0) + (opts.readCount || 0) < 1 &&
    !opts.madeEdits &&
    !opts.hasSeedTargets;
  if (opts.mode === 'plan' && exploring) {
    return AGENT_TOOLS.filter((t) => EXPLORE_TOOL_NAMES.has(t.function.name));
  }
  if (exploring) {
    return AGENT_TOOLS.filter((t) => EXPLORE_TOOL_NAMES.has(t.function.name));
  }
  return AGENT_TOOLS.filter((t) => EDIT_TOOL_NAMES.has(t.function.name));
}

/** Per-step completion budget — edits need room for tool-call JSON + patches. */
export function routingMaxTokens(step: number, madeEdits: boolean): number {
  if (madeEdits) {
    return 3200;
  }
  if (step === 0) {
    return 2600;
  }
  return 2800;
}
