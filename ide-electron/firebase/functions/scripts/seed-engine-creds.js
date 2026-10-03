'use strict';

/**
 * Retired. Provider keys are not copied into Firestore or into the client.
 * The OpenRouter key lives only in the encrypted WordPress vault
 * (engine-vault.php + engine-kek.php), and the broker attaches it upstream.
 */
console.error(
  'Refusing to copy an OpenRouter key into Firestore. Keep it in the encrypted WordPress vault.',
);
process.exit(1);
