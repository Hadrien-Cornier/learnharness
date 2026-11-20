import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
rmSync('dist-custom', { recursive: true, force: true });
rmSync('.next/standalone', { recursive: true, force: true });
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function addCustomModels() {
  const models = JSON.parse(readFileSync(new URL('./custom-models.json', import.meta.url), 'utf8'));
  const catalogDir = '.next/standalone/node_modules/@earendil-works/pi-ai/dist/providers/data';
  for (const [provider, additions] of Object.entries(models)) {
    const file = `${catalogDir}/${provider}.json`;
    const catalog = JSON.parse(readFileSync(file, 'utf8'));
    for (const model of additions) {
      catalog[model.api][`${model.type}:${model.id}`] ??= model;
    }
    writeFileSync(file, `${JSON.stringify(catalog, null, '\t')}\n`);
  }
}

run('npm', ['run', 'build']);
addCustomModels();
run('node', ['scripts/smoke-provider-runtime.mjs']);
run('node', ['scripts/build-server.mjs']);
run('node', ['scripts/smoke-server.mjs', '--electron']);
run('npx', ['electron-builder', '--config', 'electron-builder.custom.cjs', '--mac', '--arm64', '--publish', 'never']);
