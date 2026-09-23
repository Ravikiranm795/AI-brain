'use strict';

const fs = require('fs');
const path = require('path');
const Parser = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');
const TypeScript = require('tree-sitter-typescript').typescript;
const TSX = require('tree-sitter-typescript').tsx;
const Java = require('tree-sitter-java');
const Python = require('tree-sitter-python');
const CSharp = require('tree-sitter-c-sharp');
const Php = require('tree-sitter-php').php;

// Per-symbol cap on the full body text stored in chunks.code (see
// pushSymbol's nodeBody()) - bounds pathological cases (a single
// minified-but-not-.min-named file, a generated 10k-line class) without
// meaningfully truncating the vast majority of real functions/methods.
const MAX_CHUNK_CHARS = 20000;

// Extensions with a real tree-sitter grammar wired into the visitor below.
// Anything else falls back to parseGenericFile (whole-file chunk, no
// fine-grained symbols) - see SUPPORTED_EXTENSIONS/GENERICALLY_PARSED_EXTENSIONS
// in config.js for the full list of extensions the walker will pick up.
const LANGUAGES_BY_EXT = {
  '.js': JavaScript,
  '.jsx': JavaScript,
  '.mjs': JavaScript,
  '.cjs': JavaScript,
  '.ts': TypeScript,
  '.tsx': TSX,
  '.java': Java,
  '.py': Python,
  '.pyw': Python,
  '.cs': CSharp,
  '.php': Php
};

/**
 * Parses a single file and returns:
 *   symbols: [{ name, kind, startLine, endLine, startByte, endByte, signature }]
 *   imports: [{ specifier, names: [] }]
 *   calls:   [{ callerName, calleeName, line, calleeLine, calleeColumn }]
 *            // name-based, resolved later against the whole graph;
 *            // calleeLine/calleeColumn (0-indexed) point at the callee
 *            // identifier itself, for optional LSP-based re-resolution
 */
function parseFile(absPath, ext, source) {
  const code = source !== undefined ? source : fs.readFileSync(absPath, 'utf8');

  const language = LANGUAGES_BY_EXT[ext];
  if (!language) {
    return parseGenericFile(absPath, code);
  }

  const parser = new Parser();
  parser.setLanguage(language);

  let tree;
  try {
    tree = parser.parse(code);
  } catch (err) {
    return { symbols: [], imports: [], calls: [], literals: [], error: `parse-failed: ${err.message}` };
  }

  const symbols = [];
  const imports = [];
  const calls = [];
  const literals = [];

  // localStorage/sessionStorage get/set/remove calls with a literal key -
  // the coupling this captures (file A writes a key, file B reads it, with
  // no function call between them) is invisible to the call graph, so it's
  // tracked separately and joined in graphStore.expand()/getCallers() as a
  // second edge kind. See STORAGE_METHODS below for the exact shape matched.
  const STORAGE_OBJECTS = new Set(['localStorage', 'sessionStorage']);
  const STORAGE_METHOD_ACTIONS = { getItem: 'read', setItem: 'write', removeItem: 'remove' };

  // Track the innermost named function/method we're currently inside, so
  // call expressions can be attributed to their enclosing symbol.
  const scopeStack = [];
  const currentScope = () => (scopeStack.length ? scopeStack[scopeStack.length - 1] : null);

  function nodeSig(node, name) {
    const startLine = node.startPosition.row + 1;
    const text = code.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 160));
    return text.split('\n')[0].trim();
  }

  // Full body text for this symbol, capped - this (not the ~160-char
  // signature) is what goes into chunks.code and gets FTS5-indexed, so
  // brain_search can match identifiers/literals that only appear inside a
  // function body, not just its first line.
  function nodeBody(node) {
    return code.slice(node.startIndex, node.endIndex).slice(0, MAX_CHUNK_CHARS);
  }

  function pushSymbol(node, name, kind) {
    const sym = {
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startByte: node.startIndex,
      endByte: node.endIndex,
      signature: nodeSig(node, name),
      body: nodeBody(node)
    };
    symbols.push(sym);
    return sym;
  }

  function visit(node) {
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration': {
        const nameNode = node.childForFieldName('name');
        const name = nameNode ? nameNode.text : '(anonymous)';
        const sym = pushSymbol(node, name, 'function');
        scopeStack.push(sym);
        for (const child of node.namedChildren) visit(child);
        scopeStack.pop();
        return;
      }
      case 'method_definition': {
        const nameNode = node.childForFieldName('name');
        const name = nameNode ? nameNode.text : '(anonymous method)';
        const sym = pushSymbol(node, name, 'method');
        scopeStack.push(sym);
        for (const child of node.namedChildren) visit(child);
        scopeStack.pop();
        return;
      }
      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        const name = nameNode ? nameNode.text : '(anonymous class)';
        pushSymbol(node, name, 'class');
        for (const child of node.namedChildren) visit(child);
        return;
      }
      // JS/TS: `new Foo(...)` - tracked as a call to `Foo` so a class picks
      // up a direct incoming edge from wherever it's constructed, not just
      // from callers of its methods (see graphStore.js's getClassMembers doc
      // comment for why a class otherwise has almost no edges of its own).
      // Only the plain-identifier constructor shape is handled (`new Foo()`),
      // same as every other call-site handler here - `new ns.Foo()` is
      // skipped rather than guessed at.
      case 'new_expression': {
        const ctorNode = node.childForFieldName('constructor');
        const scope = currentScope();
        if (ctorNode && ctorNode.type === 'identifier' && scope) {
          calls.push({
            callerName: scope.name,
            calleeName: ctorNode.text,
            line: node.startPosition.row + 1,
            calleeLine: ctorNode.startPosition.row,
            calleeColumn: ctorNode.startPosition.column
          });
        }
        break;
      }
      // Python: function_definition covers both top-level functions and
      // methods (there's no separate method_definition node type like JS) -
      // it's a method only when its immediate containing block belongs to a
      // class_definition (walking through decorated_definition wrappers).
      case 'function_definition': {
        const nameNode = node.childForFieldName('name');
        const name = nameNode ? nameNode.text : '(anonymous)';
        let container = node.parent;
        while (container && container.type === 'decorated_definition') container = container.parent;
        const isMethod = !!(container && container.type === 'block' && container.parent && container.parent.type === 'class_definition');
        const sym = pushSymbol(node, name, isMethod ? 'method' : 'function');
        scopeStack.push(sym);
        for (const child of node.namedChildren) visit(child);
        scopeStack.pop();
        return;
      }
      case 'class_definition': {
        const nameNode = node.childForFieldName('name');
        const name = nameNode ? nameNode.text : '(anonymous class)';
        pushSymbol(node, name, 'class');
        for (const child of node.namedChildren) visit(child);
        return;
      }
      // Python: `from a.b import c` - childForFieldName('name') isn't set
      // (only plain `import a.b.c` uses it), so read children positionally.
      // Imported names come as plain `dotted_name` (`c`) or, for `c as d`,
      // an `aliased_import` wrapping a `dotted_name` under its 'name' field.
      case 'import_from_statement': {
        const moduleNode = node.namedChildren.find(
          (c) => c.type === 'dotted_name' || c.type === 'relative_import'
        );
        const specifier = moduleNode ? moduleNode.text : null;
        const names = [];
        for (const c of node.namedChildren) {
          if (c === moduleNode) continue;
          if (c.type === 'dotted_name') names.push(c.text);
          else if (c.type === 'aliased_import') {
            const n = c.childForFieldName('name');
            if (n) names.push(n.text);
          }
        }
        if (specifier) imports.push({ specifier, names });
        break;
      }
      // Python: `call` is the equivalent of JS's call_expression; the callee
      // is either a bare identifier or an `attribute` (obj.method()), where
      // JS instead has member_expression/property.
      case 'call': {
        const fnNode = node.childForFieldName('function');
        let calleeName = null;
        let calleeNode = null;
        if (fnNode) {
          if (fnNode.type === 'identifier') {
            calleeName = fnNode.text;
            calleeNode = fnNode;
          } else if (fnNode.type === 'attribute') {
            const attr = fnNode.childForFieldName('attribute');
            if (attr) {
              calleeName = attr.text;
              calleeNode = attr;
            }
          }
        }
        const scope = currentScope();
        if (calleeName && scope) {
          calls.push({
            callerName: scope.name,
            calleeName,
            line: node.startPosition.row + 1,
            calleeLine: calleeNode ? calleeNode.startPosition.row : node.startPosition.row,
            calleeColumn: calleeNode ? calleeNode.startPosition.column : node.startPosition.column
          });
        }
        break;
      }
      // Java: interfaces have no direct JS/TS equivalent in this schema's
      // symbol kinds, so they're tracked as 'class' - same as JS classes,
      // good enough for "what's declared here / what calls into it" nav.
      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        const name = nameNode ? nameNode.text : '(anonymous interface)';
        pushSymbol(node, name, 'class');
        for (const child of node.namedChildren) visit(child);
        return;
      }
      // Java: method_declaration/constructor_declaration are this
      // grammar's equivalent of JS's method_definition.
      case 'method_declaration':
      case 'constructor_declaration': {
        const nameNode = node.childForFieldName('name');
        const name = nameNode ? nameNode.text : '(anonymous method)';
        const sym = pushSymbol(node, name, 'method');
        scopeStack.push(sym);
        for (const child of node.namedChildren) visit(child);
        scopeStack.pop();
        return;
      }
      // Java, C# and PHP all name this node type `object_creation_expression`
      // (harmless collision - a given parse only ever runs one grammar), but
      // shape it differently: Java/C# expose a `type` field (`type_identifier`
      // vs. plain `identifier`), while PHP has no field name at all - the
      // class being constructed is just the first named child, either a
      // plain `name` or (for `new \Ns\Foo()`) a `qualified_name` whose text
      // includes the leading namespace, so only the final segment after the
      // last backslash is used, to match how the class itself got indexed
      // (see pushSymbol - it stores the bare class name). See the JS
      // new_expression case above for why this matters for a class's blast
      // radius. Generic/qualified forms (`new List<Foo>()`, `new ns.Foo()`)
      // are skipped rather than guessed at, same policy as every other
      // call-site handler here.
      case 'object_creation_expression': {
        const scope = currentScope();
        if (!scope) break;
        const typeNode = node.childForFieldName('type');
        let calleeName = null;
        let calleeNode = null;
        if (typeNode && (typeNode.type === 'type_identifier' || typeNode.type === 'identifier')) {
          calleeName = typeNode.text;
          calleeNode = typeNode;
        } else if (!typeNode) {
          const target = node.namedChild(0);
          if (target && (target.type === 'name' || target.type === 'qualified_name')) {
            const segments = target.text.split('\\');
            calleeName = segments[segments.length - 1] || null;
            calleeNode = target;
          }
        }
        if (calleeName) {
          calls.push({
            callerName: scope.name,
            calleeName,
            line: node.startPosition.row + 1,
            calleeLine: calleeNode.startPosition.row,
            calleeColumn: calleeNode.startPosition.column
          });
        }
        break;
      }
      // Java: method_invocation carries a clean `name` field regardless of
      // whether it's called on an object (`obj.method()`) or bare
      // (`method()`), unlike JS's call_expression/member_expression split.
      case 'method_invocation': {
        const nameNode = node.childForFieldName('name');
        const calleeName = nameNode ? nameNode.text : null;
        const scope = currentScope();
        if (calleeName && scope) {
          calls.push({ callerName: scope.name, calleeName, line: node.startPosition.row + 1 });
        }
        break;
      }
      // C#: `using System;` / `using MyApp.Services;` - the target is a
      // positional (unnamed-field) identifier or qualified_name child,
      // unlike Java's import_declaration which has the same shape but no
      // dedicated field name either - read it the same way.
      case 'using_directive': {
        const target = node.namedChildren.find((c) => c.type === 'qualified_name' || c.type === 'identifier');
        if (target) imports.push({ specifier: target.text, names: [] });
        break;
      }
      // C#: invocation_expression is this grammar's call_expression - the
      // callee is a bare identifier or a member_access_expression (fields
      // `expression`/`name`), analogous to JS's identifier/member_expression
      // split.
      case 'invocation_expression': {
        const fnNode = node.childForFieldName('function');
        let calleeName = null;
        let calleeNode = null;
        if (fnNode) {
          if (fnNode.type === 'identifier') {
            calleeName = fnNode.text;
            calleeNode = fnNode;
          } else if (fnNode.type === 'member_access_expression') {
            const nameField = fnNode.childForFieldName('name');
            if (nameField) {
              calleeName = nameField.text;
              calleeNode = nameField;
            }
          }
        }
        const scope = currentScope();
        if (calleeName && scope) {
          calls.push({
            callerName: scope.name,
            calleeName,
            line: node.startPosition.row + 1,
            calleeLine: calleeNode ? calleeNode.startPosition.row : node.startPosition.row,
            calleeColumn: calleeNode ? calleeNode.startPosition.column : node.startPosition.column
          });
        }
        break;
      }
      // PHP: `use App\Services\Helper;` / `use ... as Alias;` - each clause
      // wraps a qualified_name (or plain name for an unqualified use); the
      // qualified_name's own text already includes the full path.
      case 'namespace_use_declaration': {
        for (const clause of node.namedChildren) {
          if (clause.type !== 'namespace_use_clause') continue;
          const target = clause.namedChildren.find((c) => c.type === 'qualified_name' || c.type === 'name');
          if (target) imports.push({ specifier: target.text, names: [] });
        }
        break;
      }
      // PHP: bare calls (`helper()`) are function_call_expression; calls on
      // an object (`$svc->compute()`, `$this->setup()`) are a distinct
      // member_call_expression with `object`/`name` fields - no unified
      // "call" node type the way Python has.
      case 'function_call_expression': {
        const fnNode = node.childForFieldName('function');
        const calleeName = fnNode ? fnNode.text : null;
        const scope = currentScope();
        if (calleeName && scope) {
          calls.push({
            callerName: scope.name,
            calleeName,
            line: node.startPosition.row + 1,
            calleeLine: fnNode.startPosition.row,
            calleeColumn: fnNode.startPosition.column
          });
        }
        break;
      }
      case 'member_call_expression': {
        const nameNode = node.childForFieldName('name');
        const calleeName = nameNode ? nameNode.text : null;
        const scope = currentScope();
        if (calleeName && scope) {
          calls.push({
            callerName: scope.name,
            calleeName,
            line: node.startPosition.row + 1,
            calleeLine: nameNode.startPosition.row,
            calleeColumn: nameNode.startPosition.column
          });
        }
        break;
      }
      case 'variable_declarator': {
        const nameNode = node.childForFieldName('name');
        const valueNode = node.childForFieldName('value');
        if (
          nameNode &&
          valueNode &&
          (valueNode.type === 'arrow_function' || valueNode.type === 'function')
        ) {
          const sym = pushSymbol(node, nameNode.text, 'function');
          scopeStack.push(sym);
          for (const child of valueNode.namedChildren) visit(child);
          scopeStack.pop();
          return;
        }
        break;
      }
      // Python also has a node type called `import_statement` (plain
      // `import a.b.c`), distinguished here by having no `source` field.
      case 'import_statement': {
        const sourceNode = node.childForFieldName('source');
        if (!sourceNode) {
          for (const c of node.namedChildren) {
            const target = c.type === 'aliased_import' ? c.childForFieldName('name') : c;
            if (target && (target.type === 'dotted_name' || target.type === 'identifier')) {
              imports.push({ specifier: target.text, names: [] });
            }
          }
          break;
        }
        const specifier = sourceNode.text.replace(/^['"]|['"]$/g, '');
        const names = [];
        const clause = node.namedChildren.find((c) => c.type === 'import_clause');
        if (clause) {
          for (const c of clause.namedChildren) {
            if (c.type === 'identifier') names.push(c.text); // default import
            if (c.type === 'named_imports') {
              for (const spec of c.namedChildren) {
                if (spec.type === 'import_specifier') {
                  const n = spec.childForFieldName('name');
                  if (n) names.push(n.text);
                }
              }
            }
            if (c.type === 'namespace_import') names.push('*');
          }
        }
        if (specifier) imports.push({ specifier, names });
        break;
      }
      // Java: `import a.b.C;` parses as a single scoped_identifier (or
      // identifier for a single-segment import) - no separate clause/named
      // list the way JS's import_statement has.
      case 'import_declaration': {
        const target = node.namedChildren.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier');
        if (target) imports.push({ specifier: target.text, names: [] });
        break;
      }
      case 'call_expression': {
        const fnNode = node.childForFieldName('function');
        let calleeName = null;
        let calleeObjectName = null;
        let calleeNode = null;
        if (fnNode) {
          if (fnNode.type === 'identifier') {
            calleeName = fnNode.text;
            calleeNode = fnNode;
          } else if (fnNode.type === 'member_expression') {
            const prop = fnNode.childForFieldName('property');
            const obj = fnNode.childForFieldName('object');
            if (prop) {
              calleeName = prop.text;
              calleeNode = prop;
            }
            if (obj && obj.type === 'identifier') calleeObjectName = obj.text;
          }
        }

        if (calleeObjectName && STORAGE_OBJECTS.has(calleeObjectName) && STORAGE_METHOD_ACTIONS[calleeName]) {
          const argsNode = node.childForFieldName('arguments');
          const firstArg = argsNode && argsNode.namedChildren[0];
          if (firstArg && (firstArg.type === 'string' || firstArg.type === 'template_string')) {
            literals.push({
              key: firstArg.text.replace(/^['"`]|['"`]$/g, ''),
              store: calleeObjectName,
              action: STORAGE_METHOD_ACTIONS[calleeName],
              scopeName: currentScope() ? currentScope().name : null,
              line: node.startPosition.row + 1
            });
          }
        }

        // Calls made inside an anonymous callback that's never assigned to a
        // named variable (e.g. `it('does x', () => {...})`) are normally
        // dropped below since there's no enclosing named scope to attribute
        // them to. Recognize the common JS test-runner call shapes as an
        // explicit, closed whitelist and give their callback its own
        // synthetic scope, so calls inside tests/suites/hooks get captured
        // without creating scope-noise for arbitrary callbacks (.map, .then,
        // IIFEs, etc. are untouched).
        const baseName = calleeObjectName || calleeName;
        const TEST_BLOCK_NAMES = new Set(['it', 'test', 'describe', 'context', 'suite']);
        const TEST_HOOK_NAMES = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'before', 'after']);

        if (TEST_BLOCK_NAMES.has(baseName) || TEST_HOOK_NAMES.has(baseName)) {
          const argsNode = node.childForFieldName('arguments');
          const argList = argsNode ? argsNode.namedChildren : [];
          const fnArg = argList.find((a) => a.type === 'arrow_function' || a.type === 'function');
          if (fnArg) {
            const isBlock = TEST_BLOCK_NAMES.has(baseName);
            const titleArg = isBlock
              ? argList.find((a) => a.type === 'string' || a.type === 'template_string')
              : null;
            const title = titleArg ? titleArg.text.replace(/^['"`]|['"`]$/g, '') : baseName;
            const kind = !isBlock ? 'hook' : baseName === 'it' || baseName === 'test' ? 'test' : 'suite';
            const sym = pushSymbol(node, title, kind);
            scopeStack.push(sym);
            visit(fnArg);
            scopeStack.pop();
            return;
          }
        }

        const scope = currentScope();
        if (calleeName && scope) {
          calls.push({
            callerName: scope.name,
            calleeName,
            line: node.startPosition.row + 1,
            calleeLine: calleeNode ? calleeNode.startPosition.row : node.startPosition.row,
            calleeColumn: calleeNode ? calleeNode.startPosition.column : node.startPosition.column
          });
        }
        break;
      }
      default:
        break;
    }

    for (const child of node.namedChildren) visit(child);
  }

  visit(tree.rootNode);

  return { symbols, imports, calls, literals };
}

/**
 * Fallback for extensions without a tree-sitter grammar wired up above
 * (html, css, go, rb, exs, ...). No AST, so no function/class-level
 * symbols or call graph - the whole file becomes one 'file'-kind symbol so
 * it's still hashed, embedded, and searchable like everything else.
 */
function parseGenericFile(absPath, code) {
  const lines = code.split('\n');
  const name = path.basename(absPath);
  const firstLine = (lines.find((l) => l.trim()) || name).trim();

  return {
    symbols: [
      {
        name,
        kind: 'file',
        startLine: 1,
        endLine: lines.length,
        startByte: 0,
        endByte: code.length,
        signature: firstLine.slice(0, 160),
        body: code.slice(0, MAX_CHUNK_CHARS)
      }
    ],
    imports: [],
    calls: [],
    literals: []
  };
}

module.exports = { parseFile, MAX_CHUNK_CHARS };
