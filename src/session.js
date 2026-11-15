'use strict';

/**
 * Per-MCP-connection memory of what's already been sent to the agent this
 * session, so a repeated brain_read/brain_context on the same code doesn't
 * resend it. Deliberately not persisted anywhere - it's scoped to one
 * server process's lifetime, purely to cut redundant token spend within a
 * single task.
 */
class SessionState {
  constructor() {
    this.shownSymbols = new Set();
    this.shownRanges = new Map(); // relPath -> [[startLine, endLine], ...]
  }

  isSymbolShown(symbolId) {
    return this.shownSymbols.has(symbolId);
  }

  markSymbolShown(symbolId) {
    this.shownSymbols.add(symbolId);
  }

  isRangeShown(relPath, startLine, endLine) {
    const ranges = this.shownRanges.get(relPath);
    if (!ranges) return false;
    return ranges.some(([s, e]) => startLine >= s && endLine <= e);
  }

  markRangeShown(relPath, startLine, endLine) {
    if (!this.shownRanges.has(relPath)) this.shownRanges.set(relPath, []);
    this.shownRanges.get(relPath).push([startLine, endLine]);
  }
}

module.exports = { SessionState };
