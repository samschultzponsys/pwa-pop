// Release versions are MAJOR.MINOR (1.0, 1.1 … 1.9, then 2.0).
// package.json stores them as MAJOR.MINOR.0 because npm requires semver.
const pkg = require('../package.json');
const [major, minor] = pkg.version.split('.').map(Number);
module.exports = { major, minor, release: `${major}.${minor}` };
if (require.main === module) process.stdout.write(module.exports.release);
