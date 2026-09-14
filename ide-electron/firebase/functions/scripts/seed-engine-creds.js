'use strict';

/**
 * Writes OpenRouter key into Firestore internal/engineCredentials (Admin-only).
 * Does not print the key. Source: OPENROUTER_API_KEY env, then local secret files.
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

function pickFromPhpArray(src) {
  const m =
    src.match(/['"]openrouter_key['"]\s*=>\s*['"]([^'"]+)['"]/) ||
    src.match(/['"]OPENROUTER_API_KEY['"]\s*=>\s*['"]([^'"]+)['"]/) ||
    src.match(/OLKIL_OPENROUTER_API_KEY['"]\s*=>\s*['"]([^'"]+)['"]/);
  return m ? String(m[1]).trim() : '';
}

function pickFromAuthJson(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return String(j.openrouter?.key || j.OPENROUTER_API_KEY || '').trim();
  } catch {
    return '';
  }
}

function findKey() {
  const env = String(process.env.OPENROUTER_API_KEY || process.env.OLKIL_OPENROUTER_API_KEY || '').trim();
  if (env) return env;
  const roots = [
    path.join(__dirname, '..', '..', '..', '..', 'wp-plugins', 'olkil-payu-checkout'),
    path.join(__dirname, '..', '..', '..', '..', 'ide-electron', 'out'),
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.olkil', 'opencode-home'),
  ];
  const names = ['engine-secrets.php', 'secrets.php', 'auth.json'];
  for (const root of roots) {
    for (const name of names) {
      const file = path.join(root, name);
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const key = name.endsWith('.json') ? pickFromAuthJson(file) : pickFromPhpArray(raw);
      if (key) return key;
    }
  }
  return '';
}

async function main() {
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: 'olkil-2c8ac' });
  }
  const key = findKey();
  if (!key) {
    console.error('No local OpenRouter key found. Set OPENROUTER_API_KEY and retry.');
    process.exit(1);
  }
  await admin.firestore().doc('internal/engineCredentials').set(
    {
      openrouterKey: key,
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      note: 'Admin SDK only. Client SDK cannot read internal/**.',
    },
    { merge: true },
  );
  console.log('Wrote internal/engineCredentials (key hidden).');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
