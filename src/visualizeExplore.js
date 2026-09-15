'use strict';

const fs = require('fs');
const path = require('path');
const { GraphStore } = require('./graphStore');
const { listAllRepoBrains } = require('./config');

/**
 * Unlike src/visualize.js's nested file->class->method containers (meant to
 * render the WHOLE graph at once), this is a flat symbol/edge list: one
 * node per symbol, one edge per call. The client never renders all of it
 * at once - it BFS's out from a single selected symbol at load time
 * instead, which is what actually makes a large repo's graph readable.
 */
function buildFlatGraphData(graph) {
  const fileById = new Map(graph.files.map((f) => [f.id, f]));

  const nodes = graph.symbols.map((sym) => {
    const file = fileById.get(sym.file_id);
    return {
      id: sym.id,
      label: sym.name,
      kind: sym.kind,
      path: file ? file.path : null,
      startLine: sym.start_line,
      endLine: sym.end_line
    };
  });

  const edges = graph.edges
    .filter((e) => e.dst_symbol_id)
    .map((e) => ({ id: e.id, source: e.src_symbol_id, target: e.dst_symbol_id, kind: e.kind }));

  return { nodes, edges };
}

function generateExploreHtml(outPath) {
  const repos = listAllRepoBrains();
  const repoData = {};

  for (const r of repos) {
    if (!fs.existsSync(path.join(r.dir, 'graph.sqlite'))) continue;
    const store = new GraphStore(r.dir);
    try {
      const graph = store.exportFullGraph();
      const { nodes, edges } = buildFlatGraphData(graph);
      repoData[r.repoId] = {
        repoId: r.repoId,
        rootDir: r.manifest ? r.manifest.rootDir : r.repoId,
        nodes,
        edges
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
<title>Project Brain - Explore</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js"></script>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #0f1115; font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #e6e6e6; }
  #topbar { display: flex; gap: 12px; align-items: center; padding: 10px 14px; background: #171a21; border-bottom: 1px solid #2a2e38; flex-wrap: wrap; position: relative; z-index: 20; }
  #topbar select, #topbar input { background: #0f1115; color: #e6e6e6; border: 1px solid #2a2e38; border-radius: 6px; padding: 6px 10px; font-size: 13px; }
  #searchWrap { position: relative; }
  #searchBox { width: 320px; }
  #results { position: absolute; top: 34px; left: 0; width: 320px; max-height: 320px; overflow-y: auto; background: #171a21; border: 1px solid #2a2e38; border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
  .result-item { padding: 8px 10px; font-size: 12px; cursor: pointer; border-bottom: 1px solid #232833; }
  .result-item:hover { background: #232833; }
  .result-item .kind { color: #9aa3b2; margin-left: 6px; }
  .result-item .path { display: block; color: #6b7690; font-size: 11px; margin-top: 2px; }
  #topbar button { background: #232833; color: #e6e6e6; border: 1px solid #2a2e38; border-radius: 6px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
  #topbar button:hover:not(:disabled) { background: #2a2e38; }
  #topbar button:disabled { opacity: 0.4; cursor: default; }
  #main { position: absolute; top: 52px; left: 0; right: 0; bottom: 0; display: flex; }
  #cy { flex: 1; position: relative; }
  #emptyState { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; color: #9aa3b2; padding: 24px; text-align: center; }
  #emptyState h2 { color: #dfe3ea; font-weight: 600; font-size: 16px; margin: 0; }
  #quickStart { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; max-width: 720px; }
  #quickStart button { background: #171a21; color: #dfe3ea; border: 1px solid #2a2e38; border-radius: 6px; padding: 8px 12px; font-size: 12px; cursor: pointer; text-align: left; }
  #quickStart button:hover { background: #232833; border-color: #4f7ac9; }
  #quickStart .qs-path { display: block; color: #6b7690; font-size: 10px; margin-top: 2px; }
  #infoPanel { width: 280px; border-left: 1px solid #2a2e38; background: #12141a; padding: 16px; font-size: 12px; overflow-y: auto; }
  #infoPanel h3 { margin: 0 0 4px 0; font-size: 14px; color: #dfe3ea; }
  #infoPanel .meta { color: #9aa3b2; line-height: 1.6; }
  #infoPanel .hint { margin-top: 14px; color: #6b7690; line-height: 1.5; }
  .legend { position: absolute; bottom: 10px; left: 10px; font-size: 11px; color: #9aa3b2; background: #171a21cc; padding: 8px 10px; border-radius: 6px; line-height: 1.6; }
  .legend .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div id="topbar">
  <select id="repoSelect"></select>
  <div id="searchWrap">
    <input id="searchBox" placeholder="Search a function, class, or file name..." />
    <div id="results" hidden></div>
  </div>
  <label style="font-size:12px;color:#9aa3b2;">Hops
    <select id="hopsSelect">
      <option value="1" selected>1</option>
      <option value="2">2</option>
    </select>
  </label>
  <button id="backBtn" disabled>&larr; Back</button>
</div>
<div id="main">
  <div id="cy" hidden></div>
  <div id="emptyState">
    <h2>Search a function, class, or file to begin</h2>
    <div>Or jump to one of the most-connected symbols in this repo:</div>
    <div id="quickStart"></div>
  </div>
  <div id="infoPanel" hidden></div>
</div>
<div class="legend">
  <div><span class="dot" style="background:#4f8cff"></span>function</div>
  <div><span class="dot" style="background:#f2a93b"></span>method</div>
  <div><span class="dot" style="background:#39c98e"></span>class</div>
  <div><span class="dot" style="background:#8f9bb3"></span>file</div>
  <div><span class="dot" style="background:#ff8fa3"></span>test</div>
  <div><span class="dot" style="background:#b98cff"></span>suite</div>
  <div><span class="dot" style="background:#6bd4c8"></span>hook</div>
</div>
<script>
const REPO_DATA = /*__REPO_DATA__*/;

const repoSelect = document.getElementById('repoSelect');
const searchBox = document.getElementById('searchBox');
const resultsEl = document.getElementById('results');
const hopsSelect = document.getElementById('hopsSelect');
const backBtn = document.getElementById('backBtn');
const cyEl = document.getElementById('cy');
const emptyStateEl = document.getElementById('emptyState');
const quickStartEl = document.getElementById('quickStart');
const infoPanelEl = document.getElementById('infoPanel');

let currentRepo = null;
let nodeById = new Map();
let outgoing = new Map();
let incoming = new Map();
let historyStack = [];
let centerId = null;
let hopCount = 1;
let cy = null;

function colorFor(kind) {
  if (kind === 'class') return '#39c98e';
  if (kind === 'method') return '#f2a93b';
  if (kind === 'file') return '#8f9bb3';
  if (kind === 'test') return '#ff8fa3';
  if (kind === 'suite') return '#b98cff';
  if (kind === 'hook') return '#6bd4c8';
  return '#4f8cff';
}

function degree(id) {
  return (outgoing.get(id) || []).length + (incoming.get(id) || []).length;
}

function loadRepo(repoId) {
  currentRepo = REPO_DATA[repoId];
  if (!currentRepo) return;

  nodeById = new Map(currentRepo.nodes.map((n) => [n.id, n]));
  outgoing = new Map();
  incoming = new Map();
  for (const e of currentRepo.edges) {
    if (!outgoing.has(e.source)) outgoing.set(e.source, []);
    outgoing.get(e.source).push(e);
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target).push(e);
  }

  historyStack = [];
  centerId = null;
  backBtn.disabled = true;
  searchBox.value = '';
  resultsEl.hidden = true;
  showEmptyState();
  renderQuickStart();
}

function renderQuickStart() {
  const top = [...currentRepo.nodes].sort((a, b) => degree(b.id) - degree(a.id)).slice(0, 12);
  quickStartEl.innerHTML = '';
  top.forEach((n) => {
    const btn = document.createElement('button');
    btn.innerHTML = n.label + ' <span class="qs-path">' + (n.path || '') + '</span>';
    btn.addEventListener('click', () => centerOn(n.id));
    quickStartEl.appendChild(btn);
  });
}

function showEmptyState() {
  if (cy) { cy.destroy(); cy = null; }
  cyEl.hidden = true;
  infoPanelEl.hidden = true;
  emptyStateEl.hidden = false;
}

function searchMatches(term) {
  const t = term.toLowerCase();
  if (!t || !currentRepo) return [];
  return currentRepo.nodes.filter((n) => n.label.toLowerCase().includes(t)).slice(0, 20);
}

searchBox.addEventListener('input', () => {
  const matches = searchMatches(searchBox.value.trim());
  resultsEl.innerHTML = '';
  resultsEl.hidden = matches.length === 0;
  matches.forEach((n) => {
    const item = document.createElement('div');
    item.className = 'result-item';
    item.innerHTML = n.label + '<span class="kind">' + n.kind + '</span><span class="path">' + (n.path || '') + '</span>';
    item.addEventListener('click', () => {
      resultsEl.hidden = true;
      searchBox.value = n.label;
      centerOn(n.id);
    });
    resultsEl.appendChild(item);
  });
});

function bfsNeighborhood(startId, hops) {
  const visited = new Set([startId]);
  let frontier = [startId];
  const nodesOut = new Map([[startId, nodeById.get(startId)]]);
  const edgesOut = [];

  for (let h = 0; h < hops; h++) {
    const next = [];
    for (const id of frontier) {
      for (const e of outgoing.get(id) || []) {
        edgesOut.push(e);
        if (!visited.has(e.target)) {
          visited.add(e.target);
          next.push(e.target);
          nodesOut.set(e.target, nodeById.get(e.target));
        }
      }
      for (const e of incoming.get(id) || []) {
        edgesOut.push(e);
        if (!visited.has(e.source)) {
          visited.add(e.source);
          next.push(e.source);
          nodesOut.set(e.source, nodeById.get(e.source));
        }
      }
    }
    frontier = next;
  }

  return { nodes: [...nodesOut.values()].filter(Boolean), edges: edgesOut };
}

function renderInfoPanel(node) {
  infoPanelEl.hidden = false;
  infoPanelEl.innerHTML =
    '<h3>' + node.label + '</h3>' +
    '<div class="meta">' +
    'kind: ' + node.kind + '<br/>' +
    'path: ' + (node.path || '-') + '<br/>' +
    'lines: ' + node.startLine + '-' + node.endLine +
    '</div>' +
    '<div class="hint">This is a static file with no live backend - to read the actual code, run <code>brain read ' +
    (node.path || '&lt;path&gt;') + ' ' + node.startLine + ' ' + node.endLine + '</code>.</div>';
}

function renderGraph(nodes, edges) {
  if (cy) cy.destroy();
  emptyStateEl.hidden = true;
  cyEl.hidden = false;

  const elements = [
    ...nodes.map((n) => ({ data: { id: 's' + n.id, label: n.label, kind: n.kind, isCenter: n.id === centerId } })),
    ...edges.map((e) => ({ data: { id: 'e' + e.id, source: 's' + e.source, target: 's' + e.target, kind: e.kind } }))
  ];

  cy = cytoscape({
    container: cyEl,
    elements,
    style: [
      { selector: 'node', style: {
          'background-color': (ele) => colorFor(ele.data('kind')),
          'label': 'data(label)',
          'font-size': 10,
          'color': '#dfe3ea',
          'width': 22,
          'height': 22,
          'text-valign': 'bottom',
          'text-margin-y': 4,
          'border-width': 0
        } },
      { selector: 'node[?isCenter]', style: {
          'width': 34,
          'height': 34,
          'border-width': 3,
          'border-color': '#ff5470',
          'font-size': 12,
          'font-weight': 700,
          'z-index': 999
        } },
      { selector: 'edge', style: {
          'width': 1.6,
          'line-color': '#6b7690',
          'target-arrow-color': '#6b7690',
          'target-arrow-shape': 'triangle',
          'arrow-scale': 0.9,
          'curve-style': 'bezier',
          'opacity': 0.7
        } }
    ],
    layout: { name: 'breadthfirst', directed: true, roots: '#s' + centerId, padding: 40, spacingFactor: 1.5, animate: false }
  });

  cy.on('tap', 'node', (evt) => {
    const id = Number(evt.target.id().slice(1));
    centerOn(id);
  });
}

function centerOn(id, pushHistory = true) {
  const node = nodeById.get(id);
  if (!node) return;
  if (pushHistory && centerId !== null && centerId !== id) historyStack.push(centerId);
  centerId = id;

  const { nodes, edges } = bfsNeighborhood(id, hopCount);
  renderGraph(nodes, edges);
  renderInfoPanel(node);
  backBtn.disabled = historyStack.length === 0;
}

backBtn.addEventListener('click', () => {
  const prev = historyStack.pop();
  backBtn.disabled = historyStack.length === 0;
  if (prev !== undefined) centerOn(prev, false);
});

hopsSelect.addEventListener('change', () => {
  hopCount = Number(hopsSelect.value);
  if (centerId !== null) centerOn(centerId, false);
});

Object.keys(REPO_DATA).forEach((repoId) => {
  const opt = document.createElement('option');
  opt.value = repoId;
  opt.textContent = repoId;
  repoSelect.appendChild(opt);
});
repoSelect.addEventListener('change', () => loadRepo(repoSelect.value));

if (Object.keys(REPO_DATA).length) {
  loadRepo(Object.keys(REPO_DATA)[0]);
} else {
  emptyStateEl.innerHTML = '<h2>No repos indexed yet</h2><div>Run <code>brain build</code> inside a repo first, then <code>brain explore</code> again.</div>';
}
</script>
</body>
</html>
`;

module.exports = { generateExploreHtml, buildFlatGraphData };
