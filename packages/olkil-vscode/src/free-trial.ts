import * as fs from 'fs';
import * as path from 'path';
import { OLKIL_HOME } from './auth';
import type { EngineCreds } from './quota';

/**
 * Free-plan cloud access. Paid plans do not use this — they stay on OpenRouter.
 * Edit this object to change the free model, endpoint, or token cap later.
 */
export const FREE_TRIAL = {
  tokenLimit: 30_000,
  baseUrl: '',
  modelId: 'deepseek/deepseek-v4-flash',
  apiKey: '',
  /** Provider id inside the local coding engine. Not an OpenRouter slug. */
  providerId: 'olkil-free',
} as const;

const TRIAL_FILE = path.join(OLKIL_HOME, 'free-trial.json');

export type FreeTrialState =
  | { kind: 'none' }
  | { kind: 'active'; used: number; left: number }
  | { kind: 'exhausted'; used: number }
  | { kind: 'blocked' };

type TrialFile = {
  machineId: string;
  ownerUid: string;
  used: number;
};

/**
 * Tokens to deduct for one free-trial turn.
 * Only the provider's own counts. No character estimates.
 * A failed call (no usage) returns 0.
 */
export function exactTrialTokens(usage: {
  prompt: number;
  completion: number;
  total: number;
  reasoning: number;
} | null): number {
  if (!usage) return 0;
  const prompt = Math.max(0, Math.floor(usage.prompt));
  const completion = Math.max(0, Math.floor(usage.completion));
  const reasoning = Math.max(0, Math.floor(usage.reasoning));
  const reported = Math.max(0, Math.floor(usage.total));
  if (reported > 0) return reported;
  const output = completion > 0 ? completion : reasoning;
  const parts = prompt + output;
  return parts > 0 ? parts : 0;
}

export function freeTrialCreds(): EngineCreds | null {
  const apiKey = FREE_TRIAL.apiKey.trim();
  const baseURL = FREE_TRIAL.baseUrl.trim().replace(/\/+$/, '');
  if (!apiKey || !baseURL) return null;
  return {
    provider: 'trial',
    baseURL,
    apiKey,
    model: FREE_TRIAL.modelId.trim(),
  };
}

function machineKey(machineId: string): string {
  const id = String(machineId || '').trim();
  return id || 'local';
}

function readFile(): TrialFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(TRIAL_FILE, 'utf8')) as Partial<TrialFile>;
    const machineId = String(raw.machineId || '');
    const ownerUid = String(raw.ownerUid || '');
    const used = Math.max(0, Math.floor(Number(raw.used) || 0));
    if (!machineId || !ownerUid) return null;
    return { machineId, ownerUid, used };
  } catch {
    return null;
  }
}

function writeFile(row: TrialFile) {
  fs.mkdirSync(path.dirname(TRIAL_FILE), { recursive: true });
  fs.writeFileSync(TRIAL_FILE, JSON.stringify(row), 'utf8');
}

function stateFor(used: number): FreeTrialState {
  if (used >= FREE_TRIAL.tokenLimit) return { kind: 'exhausted', used };
  return { kind: 'active', used, left: FREE_TRIAL.tokenLimit - used };
}

/**
 * First free account on this computer claims the trial.
 * A later account on the same machine id is blocked.
 * Pass knowTheyAreFree only after the plan check says this account is not paid.
 */
export function openFreeTrial(machineId: string, uid: string, knowTheyAreFree: boolean): FreeTrialState {
  const id = String(uid || '').trim();
  if (!id) return { kind: 'none' };
  const machine = machineKey(machineId);
  const row = readFile();
  if (row && row.machineId === machine && row.ownerUid !== id) return { kind: 'blocked' };
  if (row && row.machineId === machine && row.ownerUid === id) return stateFor(row.used);
  if (!knowTheyAreFree) return { kind: 'none' };
  const created: TrialFile = { machineId: machine, ownerUid: id, used: row && row.ownerUid === id ? row.used : 0 };
  writeFile(created);
  return stateFor(created.used);
}

/** Add tokens for the account that owns this computer's trial. */
export function recordFreeTrialUse(machineId: string, uid: string, tokens: number): FreeTrialState {
  const id = String(uid || '').trim();
  const add = Math.max(0, Math.floor(tokens));
  if (!id || add < 1) return openFreeTrial(machineId, id, false);
  const machine = machineKey(machineId);
  const row = readFile();
  if (!row || row.machineId !== machine || row.ownerUid !== id) return openFreeTrial(machineId, id, false);
  const next: TrialFile = { ...row, used: row.used + add };
  writeFile(next);
  return stateFor(next.used);
}
