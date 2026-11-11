// Bumps the release version: 1.0 -> 1.1 -> … -> 1.9 -> 2.0.
// Moves the "Unreleased" section of CHANGELOG.md under the new version heading.
//   node scripts/bump.js          (or: npm run version:bump)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pkgFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
let [major, minor] = pkg.version.split('.').map(Number);
minor += 1;
if (minor > 9) { major += 1; minor = 0; }
const next = `${major}.${minor}`;
pkg.version = `${next}.0`;
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');

const lockFile = path.join(root, 'package-lock.json');
if (fs.existsSync(lockFile)) {
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  lock.version = pkg.version;
  if (lock.packages && lock.packages['']) lock.packages[''].version = pkg.version;
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
}

const clFile = path.join(root, 'CHANGELOG.md');
let cl = fs.readFileSync(clFile, 'utf8');
const date = new Date().toISOString().slice(0, 10);
if (cl.includes('## [Unreleased]')) {
  cl = cl.replace('## [Unreleased]', `## [Unreleased]\n\n## [${next}] - ${date}`);
} else {
  cl = cl.replace(/^(# .*\n(?:.*\n)*?)(## )/m, `$1## [${next}] - ${date}\n\n$2`);
}
fs.writeFileSync(clFile, cl);
console.log(`Version bumped to ${next}`);

// Keep the Flatpak AppStream release list in sync.
const metaFile = path.join(root, 'flatpak', 'io.github.samschultzponsys.WebRoost.metainfo.xml');
if (fs.existsSync(metaFile)) {
  const meta = fs.readFileSync(metaFile, 'utf8');
  fs.writeFileSync(metaFile, meta.replace('<releases>', `<releases>\n    <release version="${next}" date="${date}"/>`));
}
