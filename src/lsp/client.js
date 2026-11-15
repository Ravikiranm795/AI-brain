'use strict';

const { spawn } = require('child_process');
const rpc = require('vscode-jsonrpc/node');
const {
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DefinitionRequest
} = require('vscode-languageserver-protocol');

const INIT_TIMEOUT_MS = 10000;
const REQUEST_TIMEOUT_MS = 5000;

/** Thrown when a language server binary can't be spawned or won't respond in time - callers must catch this and fall back, never abort a build over it. */
class LspUnavailableError extends Error {}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new LspUnavailableError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Minimal generic LSP client over vscode-jsonrpc, standalone (no VS Code
 * extension-host dependency, unlike vscode-languageclient). Only implements
 * the handful of requests src/lsp/resolveCalls.js needs.
 */
class LspClient {
  constructor(command, args) {
    this.command = command;
    this.args = args;
    this.process = null;
    this.connection = null;
  }

  async start(rootUri) {
    try {
      this.process = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (err) {
      throw new LspUnavailableError(`failed to spawn ${this.command}: ${err.message}`);
    }

    // child_process.spawn() is asynchronous - a bad command (ENOENT) only
    // surfaces via a later 'error' event, not a thrown exception here. Wait
    // for the OS to confirm the process actually started before touching
    // its stdio streams at all: writing to stdin before that (or after a
    // failed spawn destroys it) throws ERR_STREAM_DESTROYED from inside
    // Node's stream internals in a way that isn't reliably catchable via a
    // promise chain, and previously crashed the whole `brain build` process.
    await new Promise((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onError = (err) => { cleanup(); reject(new LspUnavailableError(`failed to spawn ${this.command}: ${err.message}`)); };
      const cleanup = () => {
        this.process.removeListener('spawn', onSpawn);
        this.process.removeListener('error', onError);
      };
      this.process.once('spawn', onSpawn);
      this.process.once('error', onError);
    });

    // A Node Writable/Readable stream with no 'error' listener crashes the
    // whole process on error (standard EventEmitter behavior) - writing to
    // stdin after the child has died or is dying is exactly the kind of
    // thing that triggers this, and it bypasses any try/catch around the
    // higher-level connection calls below entirely.
    this.process.stdin.on('error', () => {});
    this.process.stdout.on('error', () => {});

    this.connection = rpc.createMessageConnection(
      new rpc.StreamMessageReader(this.process.stdout),
      new rpc.StreamMessageWriter(this.process.stdin)
    );
    // Defense in depth: a server that crashes mid-session should end this
    // client's usefulness, not take down the whole build process.
    this.connection.onError(() => {});
    this.connection.onClose(() => {});
    this.connection.listen();

    const initialize = this.connection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri,
      capabilities: {}
    });

    await withTimeout(initialize, INIT_TIMEOUT_MS, `${this.command} did not respond to initialize within ${INIT_TIMEOUT_MS}ms`);
    this.connection.sendNotification(InitializedNotification.type, {});
  }

  didOpen(uri, languageId, text) {
    this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId, version: 1, text }
    });
  }

  /**
   * 0-indexed line/character, per the LSP spec. Individually timed out - a
   * single call site the server never answers for (bad position, server
   * still indexing, etc.) must not hang the entire precise-resolution pass.
   */
  definition(uri, line, character) {
    const request = this.connection.sendRequest(DefinitionRequest.type, {
      textDocument: { uri },
      position: { line, character }
    });
    return withTimeout(request, REQUEST_TIMEOUT_MS, 'definition request timed out');
  }

  /**
   * Deliberately skips the polite LSP shutdown/exit request handshake: this
   * client only ever runs short, query-only sessions against the server
   * (no state worth letting it flush), and attempting that handshake races
   * against the server tearing down its own stdio - writing the `exit`
   * notification after a `shutdown` response that already closed the pipe
   * is exactly the write-after-destroy failure this used to crash on.
   * Directly killing the process is simpler and just as effective here.
   */
  async dispose() {
    try {
      if (this.connection) this.connection.dispose();
    } catch (_) {
      // best-effort only - the process kill below is what actually matters
    }
    if (this.process && !this.process.killed) {
      try {
        this.process.kill();
      } catch (_) {
        // process may have already exited on its own
      }
    }
    // Killing the process can trigger a queued internal write failure in
    // vscode-jsonrpc's writer on a later tick, once the OS actually tears
    // down the pipe - not synchronously with the kill() call above. Callers
    // (see resolveCalls.js) keep their uncaughtException safety net armed
    // for as long as this promise is pending, so give that tick room to
    // happen here rather than after dispose() has already returned.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

module.exports = { LspClient, LspUnavailableError };
