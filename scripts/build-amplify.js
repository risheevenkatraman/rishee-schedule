import { build } from 'esbuild';
import { mkdir, cp, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const settings = {
  region: process.env.APP_REGION,
  table: process.env.APP_TABLE_NAME,
  bucket: process.env.APP_BUCKET_NAME,
  secretArn: process.env.APP_SECRET_ARN,
  origin: process.env.APP_ORIGIN,
};
for (const [name, value] of Object.entries(settings)) {
  if (!value)
    throw new Error(
      `Missing Amplify configuration: ${name}. See docs/amplify-setup.md.`,
    );
}
const origin = new URL(settings.origin);
if (origin.protocol !== 'https:' || origin.origin !== settings.origin)
  throw new Error(
    'APP_ORIGIN must be an HTTPS origin without a trailing slash or path.',
  );
const output = path.resolve('.amplify-hosting');
const compute = path.join(output, 'compute', 'default');
await mkdir(compute, { recursive: true });
for (const file of await readdir(output))
  if (!['compute', 'deploy-manifest.json'].includes(file))
    throw new Error(
      'Unexpected deployment root artifact. Use a clean checkout.',
    );
for (const file of await readdir(path.join(output, 'compute')))
  if (file !== 'default')
    throw new Error('Unexpected compute artifact. Use a clean checkout.');
// Never copy the repository, docs, local database, .env, or password into output.
// Reject stale unknown files rather than risking publishing them.
const allowed = new Set([
  'server.mjs',
  'entry.mjs',
  'runtime-config.json',
  'public',
]);
for (const file of await readdir(compute))
  if (!allowed.has(file))
    throw new Error(
      `Unexpected deployment artifact: ${file}. Use a clean checkout.`,
    );
await build({
  entryPoints: ['server.js'],
  outfile: path.join(compute, 'server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
await mkdir(path.join(compute, 'public'), { recursive: true });
for (const file of await readdir(path.join(compute, 'public')))
  if (!['index.html', 'app.js', 'style.css'].includes(file))
    throw new Error('Unexpected public artifact. Use a clean checkout.');
for (const file of ['index.html', 'app.js', 'style.css'])
  await cp(path.join('public', file), path.join(compute, 'public', file));
await writeFile(
  path.join(compute, 'runtime-config.json'),
  JSON.stringify(settings),
);
await writeFile(
  path.join(compute, 'entry.mjs'),
  `import { readFileSync } from 'node:fs';\nprocess.env.APP_CLOUD_CONFIG = readFileSync(new URL('./runtime-config.json', import.meta.url), 'utf8');\nprocess.env.PORT = '3000';\nprocess.env.HOST = '0.0.0.0';\nawait import('./server.mjs');\n`,
);
await writeFile(
  path.join(output, 'deploy-manifest.json'),
  JSON.stringify(
    {
      version: 1,
      routes: [{ path: '/*', target: { kind: 'Compute', src: 'default' } }],
      computeResources: [
        { name: 'default', runtime: 'nodejs24.x', entrypoint: 'entry.mjs' },
      ],
      framework: { name: 'node', version: '24.0.0' },
    },
    null,
    2,
  ),
);
console.log(
  'Amplify bundle ready. Only public UI, server code, and non-secret resource identifiers are included.',
);
