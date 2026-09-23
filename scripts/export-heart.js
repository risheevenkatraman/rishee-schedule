import { readFile, writeFile } from 'node:fs/promises';
import { format, resolveConfig } from 'prettier';

// Only the static Server Component markup is embedded in the existing app.
// Next.js hydration scripts are unnecessary: the formation animates with CSS.
const exportedPage = await readFile('heart/out/index.html', 'utf8');
const heart = exportedPage.match(
  /<main id="particle-heart-export">([\s\S]*?)<\/main>/,
)?.[1];

if (!heart || !heart.includes('heart-particle')) {
  throw new Error('The Next.js export did not contain the particle heart.');
}

const filename = 'public/index.html';
const html = await readFile(filename, 'utf8');
const region =
  /<!-- particle-heart:start -->[\s\S]*?<!-- particle-heart:end -->/;
if (!region.test(html)) {
  throw new Error('The loading screen particle-heart markers are missing.');
}

const updated = html.replace(
  region,
  `<!-- particle-heart:start -->\n${heart}\n<!-- particle-heart:end -->`,
);
await writeFile(
  filename,
  await format(updated, {
    ...(await resolveConfig(filename)),
    filepath: filename,
  }),
);
console.log('Exported the Next.js particle heart into the loading screen.');
