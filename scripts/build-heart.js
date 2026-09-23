import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// Next.js builds only the decorative heart, not the hosted application.
// Keep the root build entry framework-neutral for Amplify's detection.
const require = createRequire(
  new URL('../heart/package.json', import.meta.url),
);
const result = spawnSync(
  process.execPath,
  [require.resolve('next/dist/bin/next'), 'build', 'heart', '--webpack'],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
await import('./export-heart.js');
