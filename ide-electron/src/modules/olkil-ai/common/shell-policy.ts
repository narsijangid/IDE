/** Full compile/bundle commands that stall the agent for minutes. */

export function isHeavyProjectBuildCommand(command: string): boolean {
  const c = String(command || '').replace(/\s+/g, ' ').trim();
  if (!c) {
    return false;
  }
  if (/\b(run\s+)?(dev|start|serve|preview|lint|test|typecheck)\b/i.test(c) && !/\bbuild\b/i.test(c)) {
    return false;
  }
  return (
    /\b(?:npm|pnpm|bun)\s+run\s+build(?:[:\w.-]*)?\b/i.test(c) ||
    /\byarn\s+(?:run\s+)?build(?:[:\w.-]*)?\b/i.test(c) ||
    /\b(?:npm|pnpm|yarn|bun)\s+run\s+compile\b/i.test(c) ||
    /\b(?:npx\s+)?(?:vite|next|nuxt|ng)\s+build\b/i.test(c) ||
    /\bwebpack\b[^;&|]*--mode\s+production\b/i.test(c)
  );
}

/** User explicitly asked to compile — then the agent may run a build. */
export function userAskedToRunBuild(text: string): boolean {
  return /\b(run (the )?build|npm run build|yarn build|pnpm(?: run)? build|production build|compile (the )?(app|project|bundle))\b/i.test(
    String(text || ''),
  );
}
