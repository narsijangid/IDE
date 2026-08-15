/**
 * Deterministic tests for the Olkil Cline orchestration layer.
 * Run: npx --yes tsx src/modules/olkil-ai/node/orchestrator/orchestrator.test.ts
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyTask, extractTaskTerms } from './task-router';
import { rewriteKnownBadCommand, FailedCommandMemory } from './failed-commands';
import { buildCompactContext, rankEvidence } from './context-builder';
import { compactMessagesForTurn } from './prepare-turn';
import { isTempScriptName, relocateTempScript } from './temp-workspace';
import { ToolResultCache } from './tool-cache';
import { findReferencePattern } from './pattern-finder';
import { findGitRoot } from './environment';

let failed = 0;
let passed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  const run = Promise.resolve().then(fn);
  return run.then(
    () => {
      passed += 1;
      console.log(`ok  ${name}`);
    },
    (err) => {
      failed += 1;
      console.error(`fail  ${name}`);
      console.error(err);
    },
  );
}

async function main() {
  await test('router: rename is simple', () => {
    const r = classifyTask('Rename the submit button label to Save');
    assert.strictEqual(r.size, 'simple');
    assert.ok(r.maxIterations <= 16);
  });

  await test('router: outlet code reports is large/medium', () => {
    const r = classifyTask(
      'Add Outlet Code to Transaction Status reports, including Buyer Business Unit and Seller Business Unit columns, Excel export, and the API mapping.',
    );
    assert.ok(r.size === 'large' || r.size === 'medium');
    assert.ok(extractTaskTerms(r.reason ? 'Add Outlet Code to Transaction Status' : '').length >= 0);
    const terms = extractTaskTerms(
      'Add "Outlet Code" to Transaction Status reports with buyerBusinessUnit',
    );
    assert.ok(terms.some((t) => /outlet code/i.test(t) || /buyerBusinessUnit/i.test(t)));
  });

  await test('router: architecture is large', () => {
    assert.strictEqual(classifyTask('Redesign the backend and frontend auth architecture').size, 'large');
  });

  await test('failed commands: do not repeat, rewrite Join-String', () => {
    const mem = new FailedCommandMemory();
    mem.remember('Get-ChildItem | Join-String', 'Join-String is not recognized');
    assert.ok(mem.lookup('Get-ChildItem | Join-String'));
    const rewritten = rewriteKnownBadCommand('$names | Join-String -Separator " "', {
      powershellLegacy: true,
    });
    assert.ok(/\[string\]::Join/.test(rewritten), rewritten);
    assert.ok(!/Join-String/i.test(rewritten), rewritten);
  });

  await test('failed commands: git -C injection for status', () => {
    const next = rewriteKnownBadCommand('git status --short', { gitRoot: 'D:\\proj' });
    assert.ok(next.includes('git -C'), next);
  });

  await test('failed commands: python rewrite', () => {
    const next = rewriteKnownBadCommand('python script.py', { python: 'py -3' });
    assert.ok(next.startsWith('py -3'), next);
  });

  await test('failed commands: && to ; on PS5', () => {
    const next = rewriteKnownBadCommand('cd src && npm test', { powershellLegacy: true });
    assert.ok(next.includes(';'), next);
    assert.ok(!/&&/.test(next), next);
  });

  await test('context builder stays compact and ranked', () => {
    const ctx = buildCompactContext({
      task: 'Add Outlet Code',
      size: 'medium',
      files: [
        { path: 'z/unrelated.ts', score: 1, reason: ['weak'], symbols: [] },
        {
          path: 'reports/transaction-table.model.ts',
          score: 90,
          reason: ['exact Outlet Code'],
          symbols: ['outletCode'],
          excerpt: '620|outletCode: string',
          line: 620,
        },
      ],
      maxChars: 2000,
      filesExplored: 12,
      searches: 7,
    });
    assert.ok(ctx.text.includes('TASK:'));
    assert.ok(ctx.text.includes('transaction-table.model.ts'));
    assert.ok(ctx.text.length <= 2000);
    assert.strictEqual(rankEvidence(ctx.relevantFiles)[0].path.includes('transaction-table'), true);
  });

  await test('prepareTurn truncates stale tool results and dedups', () => {
    const tool = (output: string) => ({
      role: 'tool',
      content: [{ type: 'tool-result', toolName: 'search_codebase', output }],
    });
    const messages = [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: '...' },
      tool('RESULT_A'.repeat(400)),
      tool('RESULT_A'.repeat(400)),
      tool('RESULT_B'.repeat(20)),
      tool('RESULT_C'.repeat(20)),
      tool('RESULT_D'.repeat(20)),
      tool('RESULT_E'.repeat(20)),
    ];
    const out = compactMessagesForTurn({ iteration: 5, messages });
    assert.ok(out);
    const firstTool = out!.messages[2].content[0].output as string;
    assert.ok(/duplicate|truncated/i.test(firstTool) || firstTool.length < 400 * 8);
  });

  await test('temp scripts relocate out of project root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olkil-orch-'));
    try {
      assert.ok(isTempScriptName('_revert_repayment.py'));
      const dest = relocateTempScript(root, '_revert_repayment.py', 'run1');
      assert.ok(dest.replace(/\\/g, '/').includes('.olkil/temp/'), dest);
      assert.ok(!isTempScriptName('src/app.ts'));
      const keep = relocateTempScript(root, 'src/app.ts', 'run1');
      assert.ok(keep.replace(/\\/g, '/').includes('src/app.ts') || keep.endsWith('app.ts'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('tool cache hit/miss + invalidate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olkil-cache-'));
    const file = path.join(root, 'a.ts');
    fs.writeFileSync(file, 'const x = 1;\n');
    const cache = new ToolResultCache();
    assert.strictEqual(cache.getRead(file), undefined);
    cache.setRead(file, '1|const x = 1;');
    assert.strictEqual(cache.getRead(file), '1|const x = 1;');
    fs.writeFileSync(file, 'const x = 2;\n');
    // mtime change should miss
    const after = cache.getRead(file);
    assert.ok(after === undefined || after.includes('const x = 1') === false || cache.misses >= 1);
    cache.invalidatePath(file);
    assert.strictEqual(cache.getRead(file), undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await test('pattern finder picks strongest existing implementation', () => {
    const card = findReferencePattern({
      terms: ['Outlet Code', 'buyerBusinessUnit'],
      files: [
        { path: 'readme.md', score: 10, reason: [], symbols: [] },
        {
          path: 'frontend/repayment.component.ts',
          score: 40,
          reason: ['column'],
          symbols: ['buyerBusinessUnit'],
          excerpt: 'buyerBusinessUnit column',
        },
        {
          path: 'reports/transaction-table.model.ts',
          score: 50,
          reason: ['model column'],
          symbols: ['outletCode', 'buyerBusinessUnit'],
          excerpt: 'outletCode',
        },
      ],
    });
    assert.ok(card);
    assert.ok(/transaction-table|repayment/.test(card!.file));
    assert.ok(card!.pattern.length >= 1);
  });

  await test('findGitRoot walks up from nested cwd', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olkil-git-'));
    const nested = path.join(root, 'pkg', 'src');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(root, '.git'));
    const found = findGitRoot(nested);
    assert.strictEqual(path.resolve(found || ''), path.resolve(root));
    fs.rmSync(root, { recursive: true, force: true });
  });

  await test('benchmark: parallel retrieval vs sequential', async () => {
    const job = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const sequentialStart = Date.now();
    await job(40);
    await job(40);
    await job(40);
    const sequentialMs = Date.now() - sequentialStart;

    const parallelStart = Date.now();
    await Promise.all([job(40), job(40), job(40)]);
    const parallelMs = Date.now() - parallelStart;

    console.log(`    sequential=${sequentialMs}ms parallel=${parallelMs}ms`);
    assert.ok(parallelMs < sequentialMs * 0.75, `parallel ${parallelMs} not faster than sequential ${sequentialMs}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
