import { access, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, extname, resolve } from 'node:path';

async function collectJavaScript(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectJavaScript(path));
    if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(path);
  }

  return files;
}

const files = [
  ...await collectJavaScript(resolve('src')),
  ...await collectJavaScript(resolve('scripts')),
  resolve('vite.config.js')
];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    stdio: 'inherit'
  });

  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const file of files) {
  const source = await readFile(file, 'utf8');
  const imports = source.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g);

  for (const match of imports) {
    let target = resolve(dirname(file), match[1]);
    if (!extname(target)) target += '.js';

    try {
      await access(target);
    } catch {
      throw new Error(`Unresolved local import ${match[1]} in ${file}`);
    }
  }
}

for (const [page, sources] of [
  ['index.html', ['src/main.js', 'src/ui.js']],
  ['bitmask.html', ['src/bitmask/test.js']]
]) {
  const html = await readFile(resolve(page), 'utf8');
  for (const file of sources) {
    const source = await readFile(resolve(file), 'utf8');
    for (const match of source.matchAll(/querySelector\(['"]#([^'"]+)['"]\)/g)) {
      if (!html.includes(`id="${match[1]}"`)) throw new Error(`Missing #${match[1]} in ${page}`);
    }
    // The isolated test declares its complete ID list in one array.
    const declared = source.match(/Object\.fromEntries\(\[([^\]]+)\]/);
    if (declared) for (const match of declared[1].matchAll(/'([^']+)'/g)) {
      if (!html.includes(`id="${match[1]}"`)) throw new Error(`Missing #${match[1]} in ${page}`);
    }
  }
}

const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
if (packageJson.dependencies?.three !== '0.185.1') {
  throw new Error('The project must remain pinned to three 0.185.1.');
}
if (packageJson.devDependencies?.vite !== '8.2.2') {
  throw new Error('The project must remain pinned to Vite 8.2.2.');
}

console.log(`Validated ${files.length} JavaScript files, local imports, DOM selectors and pinned package versions.`);
