'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { loadUserConfig } = require('./userConfig');

// Directories this process has already confirmed exist (and created if
// needed) - getBrainsHome()/getRepoBrainDir() are called on every single MCP
// tool handler's hot path (see mcpServer.js), so without this an idle
// long-lived server process re-stats (and, on the happy path, still
// re-stats even when nothing's wrong) the same couple of directories on
// every tool call for its whole lifetime. A directory removed out from
// under a running process is not a case this cache needs to handle - that's
// already true of the store/vector-index handles StoreCache keeps open.
const verifiedDirs = new Set();

function ensureDirExists(dir) {
  if (verifiedDirs.has(dir)) return dir;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  verifiedDirs.add(dir);
  return dir;
}

/**
 * Central store for ALL repo brains lives here.
 * Override with the BRAIN_HOME env var, e.g. on Windows:
 *   setx BRAIN_HOME C:\brains
 */
function getBrainsHome() {
  const home = process.env.BRAIN_HOME || path.join(os.homedir(), '.brains');
  return ensureDirExists(home);
}

/**
 * `<basename>-<hash of the resolved absolute path>`, matching the layout
 * documented in README §8 - the basename keeps the brain directory
 * human-readable (e.g. `<BRAIN_HOME>/my-repo-a1b2c3d4`), and the hash
 * suffix is what actually makes the id unique. Without it, two different
 * repos that happen to share a folder name (e.g. two separate checkouts
 * both named `frontend`) would silently collide on one brain folder - the
 * second repo's `brain build` would overwrite the first's index.
 */
function getRepoId(rootDir) {
  const abs = path.resolve(rootDir);
  const base = path.basename(abs).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'repo';
  const hash = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

function getRepoBrainDir(rootDir) {
  const dir = path.join(getBrainsHome(), getRepoId(rootDir));
  return ensureDirExists(dir);
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

// Files above this size are skipped by the walker regardless of extension -
// a single-file override isn't worth the config surface; a legitimate source
// file this large is itself a smell. See walker.js's walk().
const MAX_FILE_SIZE_BYTES = 300 * 1024;

// Early-warning margin below vectorIndex.js's documented ~200k-symbol
// brute-force-search ceiling (see its class doc comment).
const VECTOR_INDEX_WARN_THRESHOLD = 150000;

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

/**
 * DEFAULT_IGNORE_DIRS plus any repo/BRAIN_HOME-level `ignoreDirs` from
 * brain.config.json (see userConfig.js) - additive, not a replacement, so a
 * misconfigured override can't accidentally un-ignore node_modules/.git.
 */
function getEffectiveIgnoreDirs(rootDir) {
  const user = loadUserConfig(rootDir, getBrainsHome());
  const extra = Array.isArray(user.ignoreDirs) ? user.ignoreDirs : [];
  return extra.length ? [...new Set([...DEFAULT_IGNORE_DIRS, ...extra])] : DEFAULT_IGNORE_DIRS;
}

/** SUPPORTED_EXTENSIONS plus any repo/BRAIN_HOME-level `extraExtensions`. */
function getEffectiveSupportedExtensions(rootDir) {
  const user = loadUserConfig(rootDir, getBrainsHome());
  const extra = Array.isArray(user.extraExtensions) ? user.extraExtensions : [];
  return extra.length ? new Set([...SUPPORTED_EXTENSIONS, ...extra]) : SUPPORTED_EXTENSIONS;
}

module.exports = {
  getBrainsHome,
  getRepoId,
  getRepoBrainDir,
  listAllRepoBrains,
  SUPPORTED_EXTENSIONS,
  FULLY_PARSED_EXTENSIONS,
  DEFAULT_IGNORE_DIRS,
  MAX_FILE_SIZE_BYTES,
  VECTOR_INDEX_WARN_THRESHOLD,
  getEffectiveIgnoreDirs,
  getEffectiveSupportedExtensions,
  isTestFile
};
