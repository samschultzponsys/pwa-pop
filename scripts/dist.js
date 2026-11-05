// Builds the Linux packages with the release version (e.g. 1.0) in every file name.
//   node scripts/dist.js            -> all targets from package.json
//   node scripts/dist.js AppImage   -> just the AppImage
const { spawnSync } = require('child_process');
const { release } = require('./version');
const targets = process.argv.slice(2);
const args = ['electron-builder', '--linux', ...targets, '--x64', '--publish', 'never'];
console.log(`Building PWA Pop ${release}: ${targets.join(', ') || 'all targets'}`);
const r = spawnSync('npx', args, { stdio: 'inherit', env: { ...process.env, RELEASE_VERSION: release } });
process.exit(r.status ?? 1);
