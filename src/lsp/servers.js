'use strict';

/**
 * Registry of languages with an LSP-based precise-resolution slice wired
 * up. Adding another language later is a new entry here plus whatever
 * languageId its server expects - no architecture change. v1 ships
 * TypeScript/JavaScript only, via typescript-language-server (npm
 * installable, matches this tool's existing ecosystem).
 */
const REGISTRY = {
  typescript: {
    command: process.env.BRAIN_TS_LSP_CMD || 'typescript-language-server',
    args: ['--stdio'],
    languageId: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
  }
};

function languageForExt(ext) {
  for (const [lang, cfg] of Object.entries(REGISTRY)) {
    if (cfg.extensions.includes(ext)) return lang;
  }
  return null;
}

module.exports = { REGISTRY, languageForExt };
