'use strict';

const fs = require('fs');
const path = require('path');
const Parser = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');
const TypeScript = require('tree-sitter-typescript').typescript;
const TSX = require('tree-sitter-typescript').tsx;
const Java = require('tree-sitter-java');
const Python = require('tree-sitter-python');

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
  '.pyw': Python
};

/**
 * Parses a single file and returns:
 *   symbols: [{ name, kind, startLine, endLine, startByte, endByte, signature }]
 *   imports: [{ specifier, names: [] }]
 *   calls:   [{ callerName, calleeName, line }]   // name-based, resolved later against the whole graph
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
    return { symbols: [], imports: [], calls: [], error: `parse-failed: ${err.message}` };
  }

  const symbols = [];
  const imports = [];
  const calls = [];

  // Track the innermost named function/method we're currently inside, so
  // call expressions can be attributed to their enclosing symbol.
  const scopeStack = [];
  const currentScope = () => (scopeStack.length ? scopeStack[scopeStack.length - 1] : null);

  function nodeSig(node, name) {
    const startLine = node.startPosition.row + 1;
    const text = code.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 160));
    return text.split('\n')[0].trim();
  }

  function pushSymbol(node, name, kind) {
    const sym = {
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startByte: node.startIndex,
      endByte: node.endIndex,
      signature: nodeSig(node, name)
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
        if (fnNode) {
          if (fnNode.type === 'identifier') calleeName = fnNode.text;
          else if (fnNode.type === 'attribute') {
            const attr = fnNode.childForFieldName('attribute');
            if (attr) calleeName = attr.text;
          }
        }
        const scope = currentScope();
        if (calleeName && scope) {
          calls.push({ callerName: scope.name, calleeName, line: node.startPosition.row + 1 });
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
        if (fnNode) {
          if (fnNode.type === 'identifier') calleeName = fnNode.text;
          else if (fnNode.type === 'member_expression') {
            const prop = fnNode.childForFieldName('property');
            if (prop) calleeName = prop.text;
          }
        }
        const scope = currentScope();
        if (calleeName && scope) {
          calls.push({ callerName: scope.name, calleeName, line: node.startPosition.row + 1 });
        }
        break;
      }
      default:
        break;
    }

    for (const child of node.namedChildren) visit(child);
  }

  visit(tree.rootNode);

  return { symbols, imports, calls };
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
        signature: firstLine.slice(0, 160)
      }
    ],
    imports: [],
    calls: []
  };
}

module.exports = { parseFile };
