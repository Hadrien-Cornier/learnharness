import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
rmSync('dist-custom', { recursive: true, force: true });
rmSync('.next/standalone', { recursive: true, force: true });
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('npm', ['run', 'build']);
run('node', ['scripts/smoke-provider-runtime.mjs']);
run('node', ['scripts/build-server.mjs']);
run('node', ['scripts/smoke-server.mjs', '--electron']);
run('npx', ['electron-builder', '--config', 'electron-builder.custom.cjs', '--mac', '--arm64', '--publish', 'never']);
