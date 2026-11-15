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
 * One canonical spelling of a repo root, so every code path that hashes it
 * lands on the same repoId. `path.resolve` alone is NOT enough: it
 * preserves whatever casing and separators the caller happened to pass, so
 * `D:\repo`, `d:\repo` and `D:/repo/` all resolve to different strings and
 * therefore hashed to three different brain directories - which is exactly
 * how one repo folder ended up with several `~/.brains/` entries, and how
 * two tool calls in one MCP session could land on different brains and
 * report "No symbol found" for an id the previous call had just returned.
 *
 * `realpathSync.native` does the real work where the path exists: it
 * returns the filesystem's own spelling (true casing, resolved symlinks/
 * junctions/8.3 short names). The win32 lowercase pass is a belt-and-braces
 * fallback for the paths realpath can't canonicalize (a root that doesn't
 * exist yet, a permission error) on the one platform whose filesystem is
 * guaranteed case-insensitive. It is deliberately NOT applied on darwin:
 * macOS volumes *can* be case-sensitive, and lowercasing there would fuse
 * two genuinely distinct repos onto one brain.
 */
// canonicalizeRootPath is on the hot path of every single tool call
// (getRepoBrainDir -> getRepoId), and realpathSync is a syscall. A repo
// root does not get renamed underneath a running process, so resolve each
// distinct input string once. Keyed on the raw argument, since that's what
// varies between callers.
const canonicalPathCache = new Map();

function canonicalizeRootPath(rootDir) {
  const cached = canonicalPathCache.get(rootDir);
  if (cached !== undefined) return cached;
  const { result, final } = computeCanonicalRootPath(rootDir);
  // Only a realpath-backed answer is final. A fallback (root not created
  // yet) must be recomputed once the folder exists, or this process would
  // keep hashing the unresolved spelling for the rest of its life.
  if (final) canonicalPathCache.set(rootDir, result);
  return result;
}

function computeCanonicalRootPath(rootDir) {
  let abs = path.resolve(rootDir);
  let final = false;
  try {
    abs = fs.realpathSync.native(abs);
    final = true;
  } catch (_) {
    /* root doesn't exist yet (a fresh `brain build` target) or isn't
       readable - fall through with the resolved path */
  }
  // Trailing separator: `path.resolve` strips it except at a drive/fs root.
  if (abs.length > 1) abs = abs.replace(/[\\/]+$/, '');
  if (process.platform === 'win32') abs = abs.toLowerCase();
  return { result: abs, final };
}

/**
 * `<basename>-<hash of the canonical absolute path>`, matching the layout
 * documented in README §8 - the basename keeps the brain directory
 * human-readable (e.g. `<BRAIN_HOME>/my-repo-a1b2c3d4`), and the hash
 * suffix is what actually makes the id unique. Without it, two different
 * repos that happen to share a folder name (e.g. two separate checkouts
 * both named `frontend`) would silently collide on one brain folder - the
 * second repo's `brain build` would overwrite the first's index.
 *
 * Hashes canonicalizeRootPath()'s output, not path.resolve()'s - see there.
 */
function getRepoId(rootDir) {
  const abs = canonicalizeRootPath(rootDir);
  const base = path.basename(abs).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'repo';
  const hash = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

/** A brain directory is only usable if it carries the manifest a build writes. */
function hasManifest(dir) {
  return fs.existsSync(path.join(dir, 'manifest.json'));
}

// canonical brain dir -> the directory actually serving that repo this
// process. Two jobs, and it must do both: it keeps the readdir+manifest
// scan in adoptLegacyBrainDir from repeating on every tool call, AND it
// pins the answer. Recording only *that* adoption had run (rather than what
// it returned) would make the first call in a process return the adopted
// legacy directory and every later call return the canonical one - two
// brains in one session, which is the precise failure this whole
// normalization exists to eliminate.
const resolvedBrainDirs = new Map();

/**
 * Brains built before getRepoId canonicalized its input live under a
 * repoId derived from some other spelling of the same root. Rather than
 * silently stranding that index (and forcing a full rebuild), adopt it:
 * find a sibling brain whose manifest records a rootDir that canonicalizes
 * to the same path, and rename it into place.
 *
 * The canonical directory may already exist and still need this: the
 * un-normalized scheme could produce several directories for one repo, and
 * the one whose name happens to match the canonical id is not necessarily
 * the one holding the real index (a half-finished build leaves a
 * manifest-less directory with a graph.sqlite but no vectors.bin). So a
 * manifest-less directory sitting on the canonical name is parked aside
 * rather than allowed to shadow a complete brain. Nothing is ever deleted -
 * the parked copy keeps a timestamped name.
 *
 * Returns the directory to actually use, or null if there was nothing to
 * adopt. If the rename can't happen (the old brain is open in another
 * process - Windows refuses to move a directory holding an open sqlite
 * handle), the legacy directory is used as-is: a slightly off-layout brain
 * still beats a silently empty one.
 */
function adoptLegacyBrainDir(canonicalDir, rootDir) {
  const home = getBrainsHome();
  const canonicalRoot = canonicalizeRootPath(rootDir);
  const canonicalId = path.basename(canonicalDir);

  let entries;
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch (_) {
    return null;
  }

  // Several legacy directories can map to one repo (one per spelling that
  // was ever used). Collect them all and adopt the most recently built, so
  // the outcome doesn't depend on directory-listing order.
  const candidates = [];
  for (const d of entries) {
    if (!d.isDirectory() || d.name === canonicalId || d.name.includes('.superseded-')) continue;
    const dir = path.join(home, d.name);
    const manifestPath = path.join(dir, 'manifest.json');
    let manifest;
    let mtimeMs;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      mtimeMs = fs.statSync(manifestPath).mtimeMs;
    } catch (_) {
      continue; // no/corrupt manifest - can't prove it's the same repo, leave it alone
    }
    if (!manifest || !manifest.rootDir) continue;
    if (canonicalizeRootPath(manifest.rootDir) !== canonicalRoot) continue;
    candidates.push({ dir, mtimeMs });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const { dir } = candidates[0];

  // Another process (a CLI build racing the MCP server) may adopt the same
  // directory between our scan and our rename. If it won, its result is the
  // canonical directory and is complete - use that rather than a legacy
  // path that no longer exists.
  const raceWinner = () => (hasManifest(canonicalDir) ? canonicalDir : null);

  if (fs.existsSync(canonicalDir) && !hasManifest(canonicalDir)) {
    try {
      fs.renameSync(canonicalDir, `${canonicalDir}.superseded-${Date.now()}`);
    } catch (_) {
      return fs.existsSync(dir) ? dir : raceWinner(); // can't clear the way - serve from the legacy dir
    }
  } else if (hasManifest(canonicalDir)) {
    return null; // already a complete canonical brain - nothing to adopt
  }
  try {
    fs.renameSync(dir, canonicalDir);
    verifiedDirs.add(canonicalDir);
    return canonicalDir;
  } catch (_) {
    return fs.existsSync(dir) ? dir : raceWinner();
  }
}

function getRepoBrainDir(rootDir) {
  const dir = path.join(getBrainsHome(), getRepoId(rootDir));
  const pinned = resolvedBrainDirs.get(dir);
  if (pinned) return pinned;

  let resolved = null;
  if (!hasManifest(dir)) resolved = adoptLegacyBrainDir(dir, rootDir);
  if (!resolved) resolved = ensureDirExists(dir);

  resolvedBrainDirs.set(dir, resolved);
  verifiedDirs.add(resolved);
  return resolved;
}

// The one folder every graph viewer reads from (see vizData.js). It lives
// beside the per-repo brains in BRAIN_HOME, so listAllRepoBrains must know
// it is not a brain.
const VIZ_DATA_DIRNAME = 'viz-data';

function getVizDataDir() {
  return ensureDirExists(path.join(getBrainsHome(), VIZ_DATA_DIRNAME));
}

function listAllRepoBrains() {
  const home = getBrainsHome();
  return fs
    .readdirSync(home, { withFileTypes: true })
    // `.superseded-*` are brain directories parked aside by
    // adoptLegacyBrainDir when a manifest-less directory was squatting on a
    // canonical repoId - retained as a safety net, but they are not brains
    // and listing them as "unknown" repos is just noise.
    .filter((d) => d.isDirectory() && !d.name.includes('.superseded-') && d.name !== VIZ_DATA_DIRNAME)
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

// The subset of GENERICALLY_PARSED_EXTENSIONS that is presentation, not
// logic. These are indexed as one whole-file blob (see parseGenericFile),
// so a single hit can be thousands of characters of markup or styles - and
// in a component-per-folder framework like Angular the .html/.scss siblings
// of a component share its name, so they match the same query as the .ts
// that actually implements the behaviour. Left ranked purely by relevance
// score, one of them can win the top slot in brain_context and eat the char
// budget before any real logic is reached. See context.js's
// contextRelevanceWeight, which is the only consumer.
const PRESENTATION_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.svg'
]);

/** True for extensions indexed as a single whole-file chunk rather than real symbols. */
function isGenericallyParsed(ext) {
  return !FULLY_PARSED_EXTENSIONS.includes(ext);
}

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
  canonicalizeRootPath,
  getRepoId,
  getRepoBrainDir,
  getVizDataDir,
  VIZ_DATA_DIRNAME,
  listAllRepoBrains,
  SUPPORTED_EXTENSIONS,
  FULLY_PARSED_EXTENSIONS,
  PRESENTATION_EXTENSIONS,
  isGenericallyParsed,
  DEFAULT_IGNORE_DIRS,
  MAX_FILE_SIZE_BYTES,
  VECTOR_INDEX_WARN_THRESHOLD,
  getEffectiveIgnoreDirs,
  getEffectiveSupportedExtensions,
  isTestFile
};
