'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * Central store for ALL repo brains lives here.
 * Override with the BRAIN_HOME env var, e.g. on Windows:
 *   setx BRAIN_HOME C:\brains
 */
function getBrainsHome() {
  const home = process.env.BRAIN_HOME || path.join(os.homedir(), '.brains');
  if (!fs.existsSync(home)) {
    fs.mkdirSync(home, { recursive: true });
  }
  return home;
}

/**
 * Every repo's id is just its folder name, so the brain directory reads
 * cleanly (e.g. `<BRAIN_HOME>/my-repo`) and re-running `brain build` from
 * that same repo always updates the same folder in place. If two different
 * repos share a basename, the second one's build reuses/overwrites the
 * first's brain folder - by design, kept simple.
 */
function getRepoId(rootDir) {
  const abs = path.resolve(rootDir);
  const base = path.basename(abs).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return base || 'repo';
}

function getRepoBrainDir(rootDir) {
  const dir = path.join(getBrainsHome(), getRepoId(rootDir));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function listAllRepoBrains() {
  const home = getBrainsHome();
  return fs
    .readdirSync(home, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(home, d.name);
      const manifestPath = path.join(dir, 'manifest.json');
      let manifest = null;
      if (fs.existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch (_) {
          /* ignore corrupt manifest */
        }
      }
      return { repoId: d.name, dir, manifest };
    });
}

// Languages with real tree-sitter symbol/call extraction (see src/parser.js).
const FULLY_PARSED_EXTENSIONS = [
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.java', '.py', '.pyw', '.cs', '.php'
];

// Everything else: still walked, hashed, and embedded (so it's searchable and
// shows up in the brain), but indexed as a single whole-file chunk rather
// than fine-grained functions/classes - see parseGenericFile in parser.js.
// Includes non-code project files (config/build/markup) that show up across
// the Angular/React/Java/.NET/PHP ecosystems this tool targets, e.g.
// package.json, appsettings.json, application.properties, pom.xml, .csproj,
// .razor/.cshtml views - so a search for "database connection string" or
// "which endpoint does this call" can still surface them.
const GENERICALLY_PARSED_EXTENSIONS = [
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
  '.ex', '.exs', '.rb', '.go', '.rs',
  '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh',
  '.kt', '.kts', '.swift', '.scala', '.dart',
  '.sh', '.bash', '.zsh', '.sql', '.pl', '.pm', '.lua', '.m', '.mm',
  '.groovy', '.hs', '.clj', '.cljs', '.graphql', '.gql', '.tf', '.fs', '.fsx',
  '.vb', '.r', '.elm',
  // Config/data/markup files common across all these ecosystems
  '.json', '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.properties',
  '.env', '.gradle',
  // .NET-specific: project files and Razor view templates
  '.csproj', '.sln', '.razor', '.cshtml', '.config'
];

const SUPPORTED_EXTENSIONS = new Set([...FULLY_PARSED_EXTENSIONS, ...GENERICALLY_PARSED_EXTENSIONS]);

// Heuristic test-file detection, covering the major conventions across the
// languages this tool parses. Used to flag `files.is_test` so `brain check`
// can tell which callers of a symbol are actual tests.
const TEST_FILE_PATTERNS = [
  /(^|\/)__tests__\//,
  /\.(test|spec)\.[jt]sx?$/, // JS/TS
  /(^|\/)test_[^/]+\.py$/,
  /_test\.py$/, // Python
  /(^|\/)[^/]*Test\.java$/,
  /(^|\/)Test[^/]*\.java$/, // JUnit
  /_test\.go$/, // Go
  /(^|\/)[^/]*Tests?\.cs$/, // .NET (xUnit/NUnit/MSTest convention: FooTests.cs)
  /(^|\/)[^/]*Test\.php$/ // PHP (PHPUnit convention: FooTest.php)
];

function isTestFile(relPath) {
  return TEST_FILE_PATTERNS.some((re) => re.test(relPath));
}

const DEFAULT_IGNORE_DIRS = [
  'node_modules',
  '.git',
  '.brain',
  '.brains',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'vendor'
];

module.exports = {
  getBrainsHome,
  getRepoId,
  getRepoBrainDir,
  listAllRepoBrains,
  SUPPORTED_EXTENSIONS,
  FULLY_PARSED_EXTENSIONS,
  DEFAULT_IGNORE_DIRS,
  isTestFile
};
