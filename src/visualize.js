'use strict';

const fs = require('fs');
const path = require('path');
const { GraphStore } = require('./graphStore');
const { listAllRepoBrains, getBrainsHome } = require('./config');

/**
 * Builds a compound (nested) element set: file -> class -> method, so the
 * layout can pack each file into its own box with its classes/methods
 * grouped inside, instead of dropping ~800 symbols into one flat force pool.
 * The schema has no explicit class_id on methods, so a method's owning
 * class is inferred by line-range containment within the same file - the
 * smallest enclosing class symbol wins.
 */
function buildCytoscapeElements(graph) {
  const symbolsByFile = new Map();
  for (const sym of graph.symbols) {
    if (!symbolsByFile.has(sym.file_id)) symbolsByFile.set(sym.file_id, []);
    symbolsByFile.get(sym.file_id).push(sym);
  }

  function findEnclosingClass(sym, siblingSymbols) {
    if (sym.kind !== 'method') return null;
    let best = null;
    for (const cand of siblingSymbols) {
      if (cand.kind !== 'class' || cand.id === sym.id) continue;
      if (cand.start_line <= sym.start_line && cand.end_line >= sym.end_line) {
        if (!best || cand.end_line - cand.start_line < best.end_line - best.start_line) {
          best = cand;
        }
      }
    }
    return best;
  }

  const elements = [];

  for (const file of graph.files) {
    const fileSymbols = symbolsByFile.get(file.id) || [];
    if (!fileSymbols.length) continue;
    elements.push({
      data: { id: `file${file.id}`, label: file.path, container: 'file', symbolCount: fileSymbols.length }
    });

    for (const sym of fileSymbols) {
      if (sym.kind === 'class') {
        elements.push({
          data: { id: `s${sym.id}`, label: sym.name, kind: 'class', container: 'class', parent: `file${file.id}`, path: file.path, startLine: sym.start_line, endLine: sym.end_line }
        });
      }
    }

    for (const sym of fileSymbols) {
      if (sym.kind === 'class') continue;
      const parentClass = findEnclosingClass(sym, fileSymbols);
      elements.push({
        data: {
          id: `s${sym.id}`,
          label: sym.name,
          kind: sym.kind,
          parent: parentClass ? `s${parentClass.id}` : `file${file.id}`,
          path: file.path,
          startLine: sym.start_line,
          endLine: sym.end_line
        }
      });
    }
  }

  const fileIdBySymbolId = new Map(graph.symbols.map((s) => [s.id, s.file_id]));

  for (const edge of graph.edges) {
    if (!edge.dst_symbol_id) continue;
    const crossFile = fileIdBySymbolId.get(edge.src_symbol_id) !== fileIdBySymbolId.get(edge.dst_symbol_id);
    elements.push({
      data: {
        id: `e${edge.id}`,
        source: `s${edge.src_symbol_id}`,
        target: `s${edge.dst_symbol_id}`,
        kind: edge.kind,
        ...(crossFile ? { crossFile: true } : {})
      }
    });
  }

  return elements;
}

function generateVisualizationHtml(outPath) {
  const repos = listAllRepoBrains();
  const repoData = {};

  for (const r of repos) {
    if (!fs.existsSync(path.join(r.dir, 'graph.sqlite'))) continue;
    const store = new GraphStore(r.dir);
    try {
      const graph = store.exportFullGraph();
      repoData[r.repoId] = {
        repoId: r.repoId,
        rootDir: r.manifest ? r.manifest.rootDir : r.repoId,
        elements: buildCytoscapeElements(graph)
      };
    } finally {
      store.close();
    }
  }

  const html = HTML_TEMPLATE.replace('/*__REPO_DATA__*/', JSON.stringify(repoData));
  fs.writeFileSync(outPath, html);
  return outPath;
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Project Brain - Graph Viewer</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/layout-base@2.0.1/layout-base.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cose-base@2.2.0/cose-base.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-fcose@2.2.0/cytoscape-fcose.js"></script>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #0f1115; font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #e6e6e6; }
  #topbar { display: flex; gap: 12px; align-items: center; padding: 10px 14px; background: #171a21; border-bottom: 1px solid #2a2e38; flex-wrap: wrap; }
  #topbar select, #topbar input { background: #0f1115; color: #e6e6e6; border: 1px solid #2a2e38; border-radius: 6px; padding: 6px 10px; font-size: 13px; }
  #topbar input { width: 280px; }
  #topbar .stat { font-size: 12px; color: #9aa3b2; margin-left: auto; }
  #topbar button { background: #232833; color: #e6e6e6; border: 1px solid #2a2e38; border-radius: 6px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
  #topbar button:hover { background: #2a2e38; }
  #topbar button.active { background: #33507a; border-color: #4f7ac9; color: #fff; }
  #cy { position: absolute; top: 46px; left: 0; right: 0; bottom: 0; }
  .legend { position: absolute; bottom: 10px; left: 10px; font-size: 11px; color: #9aa3b2; background: #171a21cc; padding: 8px 10px; border-radius: 6px; line-height: 1.6; }
  .legend .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; }
  .legend .box { display: inline-block; width: 12px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
</style>
</head>
<body>
<div id="topbar">
  <select id="repoSelect"></select>
  <input id="searchBox" placeholder="Search a function, class, or file name..." />
  <button id="fitBtn">Fit view</button>
  <button id="relayoutBtn">Re-layout</button>
  <button id="crossFileBtn">Show cross-file links only</button>
  <div class="stat" id="stat"></div>
</div>
<div id="cy"></div>
<div class="legend">
  <div><span class="dot" style="background:#4f8cff"></span>function</div>
  <div><span class="dot" style="background:#f2a93b"></span>method</div>
  <div><span class="dot" style="background:#39c98e"></span>class</div>
  <div><span class="box" style="background:#1c2029;border:1px solid #333a48"></span>file (container)</div>
  <div><span class="box" style="background:#20262f;border:1px solid #3a4152"></span>class (container)</div>
</div>
<script>
if (typeof cytoscapeFcose !== 'undefined') {
  cytoscape.use(cytoscapeFcose);
}

const REPO_DATA = /*__REPO_DATA__*/;

const repoSelect = document.getElementById('repoSelect');
const searchBox = document.getElementById('searchBox');
const statEl = document.getElementById('stat');
const fitBtn = document.getElementById('fitBtn');
const relayoutBtn = document.getElementById('relayoutBtn');
const crossFileBtn = document.getElementById('crossFileBtn');
let cy = null;
let crossFileOnly = false;

function colorFor(kind) {
  if (kind === 'class') return '#39c98e';
  if (kind === 'method') return '#f2a93b';
  return '#4f8cff';
}

const LAYOUT_OPTS = {
  name: 'fcose',
  animate: false,
  quality: 'proof',
  randomize: false,
  nodeDimensionsIncludeLabels: true,
  packComponents: true,
  nodeRepulsion: 9000,
  idealEdgeLength: 90,
  edgeElasticity: 0.3,
  nestingFactor: 0.1,
  gravity: 0.15,
  gravityRangeCompound: 1.5,
  gravityCompound: 1.2,
  tile: true,
  tilingPaddingVertical: 60,
  tilingPaddingHorizontal: 60,
  componentSpacing: 160
};

function loadRepo(repoId) {
  const data = REPO_DATA[repoId];
  if (!data) return;
  if (cy) cy.destroy();

  cy = cytoscape({
    container: document.getElementById('cy'),
    elements: data.elements,
    style: [
      // File containers - the outermost "area section" boxes
      { selector: 'node[container = "file"]', style: {
          'shape': 'round-rectangle',
          'background-color': '#1c2029',
          'background-opacity': 0.9,
          'border-width': 1,
          'border-color': '#333a48',
          'label': 'data(label)',
          'font-size': 10,
          'font-weight': 600,
          'color': '#8f9bb3',
          'text-valign': 'top',
          'text-halign': 'center',
          'text-margin-y': -14,
          'padding': 26
        } },
      // Class containers nested inside a file box
      { selector: 'node[container = "class"]', style: {
          'shape': 'round-rectangle',
          'background-color': '#20262f',
          'background-opacity': 0.95,
          'border-width': 1,
          'border-color': '#3a4152',
          'label': 'data(label)',
          'font-size': 9,
          'font-weight': 600,
          'color': '#39c98e',
          'text-valign': 'top',
          'text-halign': 'center',
          'text-margin-y': -10,
          'padding': 18
        } },
      // Leaf symbol nodes - functions and methods
      { selector: 'node[!container]', style: {
          'background-color': (ele) => colorFor(ele.data('kind')),
          'label': 'data(label)',
          'font-size': 8,
          'color': '#dfe3ea',
          'width': 12,
          'height': 12,
          'text-valign': 'bottom',
          'text-margin-y': 3
        } },
      { selector: 'edge', style: {
          'width': 1.4,
          'line-color': '#6b7690',
          'target-arrow-color': '#6b7690',
          'target-arrow-shape': 'triangle',
          'arrow-scale': 0.8,
          'curve-style': 'bezier',
          'opacity': 0.55,
          'z-index': 10
        } },
      // Edges that cross file boundaries are the real "connectivity" signal - make them stand out more than intra-file noise
      { selector: 'edge[?crossFile]', style: {
          'line-color': '#8fa3c9',
          'width': 1.8,
          'opacity': 0.75
        } },
      { selector: 'node[!container].highlighted', style: { 'background-color': '#ff5470', 'opacity': 1, 'z-index': 999 } },
      { selector: 'node[?container].highlighted', style: {
          'border-color': '#ff5470',
          'border-width': 2.5,
          'background-color': (ele) => ele.data('container') === 'file' ? '#1c2029' : '#20262f',
          'opacity': 1,
          'z-index': 999
        } },
      { selector: 'edge.highlighted', style: { 'line-color': '#ff5470', 'target-arrow-color': '#ff5470', 'opacity': 1, 'width': 2.5, 'z-index': 999 } },
      { selector: '.dimmed', style: { 'opacity': 0.05 } }
    ],
    layout: LAYOUT_OPTS
  });

  const leafCount = data.elements.filter((e) => e.data && !e.data.source && !e.data.container).length;
  const edgeCount = data.elements.filter((e) => e.data && e.data.source).length;
  statEl.textContent = leafCount + ' symbols, ' + edgeCount + ' edges, grouped by file/class — ' + data.rootDir;

  applyCrossFileFilter();
}

/** Hides intra-file edges (and any leaf/container left with no visible link) so only real cross-file structure shows. */
function applyCrossFileFilter() {
  if (!cy) return;
  if (!crossFileOnly) {
    cy.elements().style('display', 'element');
    return;
  }
  cy.edges().forEach((e) => e.style('display', e.data('crossFile') ? 'element' : 'none'));
}

function highlight(term) {
  if (!cy) return;
  cy.elements().removeClass('highlighted').removeClass('dimmed');
  if (!term) return;

  const t = term.toLowerCase();
  const allMatches = cy.nodes().filter((n) => n.data('label').toLowerCase().includes(t));

  if (!allMatches.length) {
    cy.elements().addClass('dimmed');
    return;
  }

  cy.elements().addClass('dimmed');
  allMatches.removeClass('dimmed').addClass('highlighted');
  allMatches.ancestors().removeClass('dimmed');
  allMatches.connectedEdges().removeClass('dimmed').addClass('highlighted');
  allMatches.connectedEdges().connectedNodes().removeClass('dimmed');

  cy.animate({ fit: { eles: allMatches.union(allMatches.ancestors()), padding: 80 } }, { duration: 300 });
}

Object.keys(REPO_DATA).forEach((repoId) => {
  const opt = document.createElement('option');
  opt.value = repoId;
  opt.textContent = repoId;
  repoSelect.appendChild(opt);
});

repoSelect.addEventListener('change', () => loadRepo(repoSelect.value));
searchBox.addEventListener('input', () => highlight(searchBox.value));
fitBtn.addEventListener('click', () => { if (cy) cy.animate({ fit: { padding: 40 } }, { duration: 250 }); });
relayoutBtn.addEventListener('click', () => { if (cy) cy.layout(LAYOUT_OPTS).run(); });
crossFileBtn.addEventListener('click', () => {
  crossFileOnly = !crossFileOnly;
  crossFileBtn.classList.toggle('active', crossFileOnly);
  crossFileBtn.textContent = crossFileOnly ? 'Show all links' : 'Show cross-file links only';
  applyCrossFileFilter();
});

if (Object.keys(REPO_DATA).length) {
  loadRepo(Object.keys(REPO_DATA)[0]);
} else {
  document.getElementById('cy').innerHTML = '<div style="padding:40px;color:#9aa3b2">No repos indexed yet. Run <code>brain build</code> inside a repo first, then <code>brain visualize</code> again.</div>';
}
</script>
</body>
</html>
`;

module.exports = { generateVisualizationHtml, buildCytoscapeElements };
