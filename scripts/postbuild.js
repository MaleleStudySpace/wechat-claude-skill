/**
 * Post-build script: Add shebang to dist/setup.js for CLI execution
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const setupPath = join(__dirname, '..', 'dist', 'setup.js');

const content = readFileSync(setupPath, 'utf-8');
const shebang = '#!/usr/bin/env node\n';

// Only add shebang if not already present
if (!content.startsWith('#!/')) {
  writeFileSync(setupPath, shebang + content);
  console.log('Added shebang to dist/setup.js');
} else {
  console.log('Shebang already present');
}
