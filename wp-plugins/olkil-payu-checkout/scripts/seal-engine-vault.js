'use strict';

/**
 * Seal OPENROUTER_API_KEY into engine-vault.php.
 * The plaintext key is never written. Run with the key in the environment.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const key = String(process.env.OPENROUTER_API_KEY || '').trim();
if (!/^sk-or-v1-[A-Za-z0-9]{64}$/.test(key)) {
  console.error('OPENROUTER_API_KEY is missing or not the expected shape.');
  process.exit(1);
}

const kek = crypto.randomBytes(32);
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
const ct = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag();
const blob = Buffer.concat([iv, tag, ct]).toString('base64');

const dir = path.join(__dirname, '..');
const kekPhp =
  "<?php\n" +
  "if ( ! defined( 'ABSPATH' ) ) {\n\texit;\n}\n" +
  'return ' +
  JSON.stringify(kek.toString('base64')) +
  ";\n";
const vaultPhp =
  "<?php\n" +
  "if ( ! defined( 'ABSPATH' ) ) {\n\texit;\n}\n" +
  'return array(\n' +
  "\t'v' => 1,\n" +
  "\t'alg' => 'aes-256-gcm',\n" +
  "\t'openrouter' => " +
  JSON.stringify(blob) +
  ",\n);\n";

fs.writeFileSync(path.join(dir, 'engine-kek.php'), kekPhp);
fs.writeFileSync(path.join(dir, 'engine-vault.php'), vaultPhp);

const decipher = crypto.createDecipheriv('aes-256-gcm', kek, iv);
decipher.setAuthTag(tag);
const back = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
if (back !== key) {
  console.error('Vault round-trip failed.');
  process.exit(1);
}
const vaultText = fs.readFileSync(path.join(dir, 'engine-vault.php'), 'utf8');
if (vaultText.includes(key) || vaultText.includes('sk-or-v1-')) {
  console.error('Vault file contains a recognizable key prefix.');
  process.exit(1);
}
console.log('Sealed OpenRouter key. vault_bytes=' + blob.length + ' prefix_absent=yes');
