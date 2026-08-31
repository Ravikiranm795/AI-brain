'use strict';

const fs = require('fs');
const Parser = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');
const TypeScript = require('tree-sitter-typescript').typescript;
const TSX = require('tree-sitter-typescript').tsx;
const Java = require('tree-sitter-java');

function languageFor(ext) {
  switch (ext) {
    case '.ts':
      return TypeScript;
    case '.tsx':
      return TSX;
    case '.java':
      return Java;
    case '.jsx':
    case '.js':
    case '.mjs':
    case '.cjs':
    default:
      return JavaScript;
  }
}

/**
 * Parses a single file and returns:
 *   symbols: [{ name, kind, startLine, endLine, startByte, endByte, signature }]
 *   imports: [{ specifier, names: [] }]
 *   calls:   [{ callerName, calleeName, line }]   // name-based, resolved later against the whole graph
 */
function parseFile(absPath, ext, source) {
  const code = source !== undefined ? source : fs.readFileSync(absPath, 'utf8');
  const parser = new Parser();
  parser.setLanguage(languageFor(ext));

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
      case 'import_statement': {
        const sourceNode = node.childForFieldName('source');
        const specifier = sourceNode ? sourceNode.text.replace(/^['"]|['"]$/g, '') : null;
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

module.exports = { parseFile };
