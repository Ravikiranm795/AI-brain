'use strict';

const fs = require('fs');
const path = require('path');
const { GraphStore } = require('./graphStore');
const { listAllRepoBrains } = require('./config');

/**
 * Builds a flat node/edge model for the dashboard viewer (unlike visualize.js's
 * compound file/class containers, this needs plain leaf nodes with a
 * `className` property instead of a parent container, plus a precomputed
 * degree since the schema has no weight/score/importance field to size or
 * rank nodes by).
 */
function buildRadialGraph(graph) {
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

  const degree = new Map();
  const inDeg = new Map();
  const outDeg = new Map();
  const bump = (map, id) => map.set(id, (map.get(id) || 0) + 1);
  for (const e of graph.edges) {
    if (!e.dst_symbol_id) continue;
    bump(degree, e.src_symbol_id);
    bump(degree, e.dst_symbol_id);
    bump(outDeg, e.src_symbol_id);
    bump(inDeg, e.dst_symbol_id);
  }

  const nodes = [];
  for (const file of graph.files) {
    const fileSymbols = symbolsByFile.get(file.id) || [];
    for (const sym of fileSymbols) {
      const parentClass = findEnclosingClass(sym, fileSymbols);
      nodes.push({
        id: `s${sym.id}`,
        symbolId: sym.id,
        label: sym.name,
        kind: sym.kind,
        path: file.path,
        fileId: file.id,
        className: parentClass ? parentClass.name : null,
        startLine: sym.start_line,
        endLine: sym.end_line,
        signature: sym.signature,
        degree: degree.get(sym.id) || 0,
        inDegree: inDeg.get(sym.id) || 0,
        outDegree: outDeg.get(sym.id) || 0
      });
    }
  }

  const fileIdBySymbolId = new Map(graph.symbols.map((s) => [s.id, s.file_id]));
  const edges = [];
  for (const edge of graph.edges) {
    if (!edge.dst_symbol_id) continue;
    const crossFile = fileIdBySymbolId.get(edge.src_symbol_id) !== fileIdBySymbolId.get(edge.dst_symbol_id);
    edges.push({
      id: `e${edge.id}`,
      source: `s${edge.src_symbol_id}`,
      target: `s${edge.dst_symbol_id}`,
      kind: edge.kind,
      crossFile
    });
  }

  return { nodes, edges };
}

function generateVisualizationHtml3(outPath) {
  const repos = listAllRepoBrains();
  const repoData = {};

  for (const r of repos) {
    if (!fs.existsSync(path.join(r.dir, 'graph.sqlite'))) continue;
    const store = new GraphStore(r.dir);
    try {
      const graph = store.exportFullGraph();
      const { nodes, edges } = buildRadialGraph(graph);
      repoData[r.repoId] = {
        repoId: r.repoId,
        rootDir: r.manifest ? r.manifest.rootDir : r.repoId,
        builtAt: r.manifest ? r.manifest.builtAt : null,
        nodes,
        edges
      };
    } finally {
      store.close();
    }
  }

  const html = HTML_TEMPLATE
    .replace('/*__REPO_DATA__*/', JSON.stringify(repoData))
    .replace('/*__GENERATED_AT__*/', JSON.stringify(new Date().toISOString()));
  fs.writeFileSync(outPath, html);
  return outPath;
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Project Brain - Knowledge Graph</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js"></script>
<style>
  :root {
    color-scheme: light;
    --bg: #f5f6f8;
    --panel: #ffffff;
    --panel-2: #fafbfc;
    --border: #e3e6ea;
    --border-soft: #edeff2;
    --text: #1a1d24;
    --text-dim: #6b7280;
    --text-faint: #9aa1ab;
    --accent: #4361ee;
    --accent-soft: rgba(67, 97, 238, 0.08);
    --accent-soft-2: rgba(67, 97, 238, 0.14);
    --danger: #e0245e;
    --fn: #4361ee;
    --method: #d97706;
    --class: #059669;
    --radius: 10px;
    --radius-sm: 7px;
    --shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 3px rgba(16, 24, 40, 0.06);
  }
  /* Celestial dark theme: deep purple space, star-like glowing nodes */
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #0c0817;
    --panel: #150f28;
    --panel-2: #1c1436;
    --border: #322a52;
    --border-soft: #241c40;
    --text: #ece9f7;
    --text-dim: #a79ecf;
    --text-faint: #6f6396;
    --accent: #a78bfa;
    --accent-soft: rgba(167, 139, 250, 0.14);
    --accent-soft-2: rgba(167, 139, 250, 0.24);
    --danger: #ff6ec7;
    --fn: #8b8bff;
    --method: #ffb454;
    --class: #4de8b0;
    --shadow: 0 2px 10px rgba(0, 0, 0, 0.45), 0 0 24px rgba(124, 58, 237, 0.12);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; height: 100%; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px; overflow: hidden;
  }
  #app { display: grid; grid-template-rows: auto 1fr auto; height: 100%; }

  /* ---------- HEADER ---------- */
  #header {
    display: flex; align-items: center; gap: 14px;
    padding: 11px 18px; background: var(--panel);
    border-bottom: 1px solid var(--border); z-index: 30;
  }
  #brand { display: flex; align-items: center; gap: 8px; font-weight: 700; letter-spacing: -0.01em; white-space: nowrap; font-size: 14px; }
  #brand .mark { width: 20px; height: 20px; border-radius: 6px; background: linear-gradient(135deg, #4361ee, #7b8cf7); flex-shrink: 0; }
  #brand .sub { font-weight: 500; color: var(--text-dim); font-size: 11px; padding: 2px 7px; background: var(--accent-soft); border-radius: 999px; }
  #breadcrumb { font-size: 11.5px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 240px; }
  #repoSelect {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 6px 10px; font-size: 12px; max-width: 210px;
  }
  #searchWrap { position: relative; flex: 1; max-width: 440px; }
  #searchBox {
    width: 100%; background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 7px 12px 7px 30px; font-size: 12.5px;
  }
  #searchBox:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  #searchWrap::before {
    content: ''; position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
    width: 12px; height: 12px; border: 1.5px solid var(--text-faint); border-radius: 50%;
  }
  #searchWrap::after {
    content: ''; position: absolute; left: 19px; top: 62%; width: 5px; height: 1.5px;
    background: var(--text-faint); transform: rotate(45deg);
  }
  #searchResults {
    position: absolute; top: 36px; left: 0; right: 0; background: var(--panel);
    border: 1px solid var(--border); border-radius: var(--radius-sm); max-height: 300px;
    overflow-y: auto; display: none; z-index: 40; box-shadow: 0 12px 28px rgba(16,24,40,0.14);
  }
  #searchResults.open { display: block; }
  #searchResults .res-item { padding: 8px 12px; cursor: pointer; display: flex; gap: 8px; align-items: center; border-bottom: 1px solid var(--border-soft); }
  #searchResults .res-item:last-child { border-bottom: none; }
  #searchResults .res-item:hover { background: var(--accent-soft); }
  #searchResults .res-item .k { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  #searchResults .res-item .n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  #searchResults .res-item .p { color: var(--text-faint); font-size: 10.5px; }
  #searchResults .empty { padding: 10px 12px; color: var(--text-faint); font-size: 12px; }

  .hbtn {
    background: var(--panel); color: var(--text); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 6px 12px; font-size: 12px; cursor: pointer;
    white-space: nowrap; display: flex; align-items: center; gap: 6px; font-weight: 500;
  }
  .hbtn:hover { background: var(--panel-2); border-color: #cfd4db; }
  .hbtn.active { background: var(--accent-soft-2); border-color: var(--accent); color: var(--accent); }
  #headerRight { display: flex; align-items: center; gap: 8px; margin-left: auto; }
  #layoutSelect {
    background: var(--panel); color: var(--text); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 6px 10px; font-size: 12px;
  }
  #zoomGroup { display: flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  #zoomGroup button { border: none; border-right: 1px solid var(--border); background: var(--panel); color: var(--text); padding: 6px 10px; cursor: pointer; font-size: 13px; }
  #zoomGroup button:last-child { border-right: none; }
  #zoomGroup button:hover { background: var(--panel-2); }

  /* ---------- BODY LAYOUT ---------- */
  #body { display: grid; grid-template-columns: 252px 1fr 320px; min-height: 0; transition: grid-template-columns 160ms ease; }
  #body.filters-collapsed { grid-template-columns: 0px 1fr 320px; }
  #body.details-collapsed { grid-template-columns: 252px 1fr 0px; }
  #body.filters-collapsed.details-collapsed { grid-template-columns: 0px 1fr 0px; }

  #filters, #detailsPanel {
    background: var(--panel); overflow-y: auto; overflow-x: hidden;
    display: flex; flex-direction: column; min-width: 0;
  }
  #filters { border-right: 1px solid var(--border); padding: 14px; gap: 16px; }
  #detailsPanel { border-left: 1px solid var(--border); }
  #body.filters-collapsed #filters, #body.details-collapsed #detailsPanel { display: none; }

  .panel-title { font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--text-dim); margin-bottom: 9px; }
  .filter-group { border-bottom: 1px solid var(--border-soft); padding-bottom: 14px; }
  .filter-group:last-child { border-bottom: none; }

  .chk-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; user-select: none; }
  .chk-row input { accent-color: var(--accent); cursor: pointer; }
  .chk-row .swatch { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .chk-row .lbl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chk-row .cnt { color: var(--text-faint); font-size: 11px; font-variant-numeric: tabular-nums; }

  #depthControl { display: flex; gap: 4px; }
  #depthControl button {
    flex: 1; background: var(--panel-2); border: 1px solid var(--border); color: var(--text-dim);
    border-radius: var(--radius-sm); padding: 6px 0; cursor: pointer; font-size: 12px; font-weight: 500;
  }
  #depthControl button.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  #depthHint { font-size: 10.5px; color: var(--text-faint); margin-top: 7px; line-height: 1.5; }

  .range-row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--text-dim); }
  .range-row input[type=range] { flex: 1; accent-color: var(--accent); }
  .range-val { color: var(--text); font-variant-numeric: tabular-nums; min-width: 20px; text-align: right; font-weight: 600; }

  #clearFiltersBtn, .clear-link {
    background: none; border: none; color: var(--accent); font-size: 11.5px; cursor: pointer; padding: 0;
    font-weight: 600;
  }

  /* Active filters (top of filter panel per spec) */
  #activeFiltersBlock { padding: 14px 14px 0; }
  #filterCountRow { display: flex; gap: 14px; font-size: 12px; margin-bottom: 10px; }
  #filterCountRow b { font-variant-numeric: tabular-nums; color: var(--text); }
  #activeChips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
  .chip {
    display: inline-flex; align-items: center; gap: 5px; background: var(--accent-soft-2);
    border: 1px solid var(--accent); color: var(--accent); border-radius: 999px; padding: 3px 8px 3px 10px; font-size: 11px; font-weight: 500;
  }
  .chip button { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 13px; line-height: 1; padding: 0; opacity: 0.7; }
  .chip button:hover { opacity: 1; }

  /* ---------- GRAPH ---------- */
  #graphWrap { position: relative; background: var(--bg); min-width: 0; }
  :root[data-theme="dark"] #graphWrap {
    background:
      radial-gradient(ellipse 60% 50% at 20% 15%, rgba(124, 58, 237, 0.20), transparent 60%),
      radial-gradient(ellipse 55% 45% at 85% 80%, rgba(76, 29, 149, 0.22), transparent 60%),
      radial-gradient(ellipse 40% 40% at 70% 10%, rgba(219, 39, 119, 0.10), transparent 60%),
      var(--bg);
  }
  #starfield { position: absolute; inset: 0; z-index: 0; display: none; }
  :root[data-theme="dark"] #starfield { display: block; }
  #cy { position: absolute; inset: 0; z-index: 1; }
  #emptyState {
    position: absolute; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; color: var(--text-dim); text-align: center; padding: 20px;
  }
  #emptyState.show { display: flex; }
  #emptyState .big { font-size: 13px; color: var(--text); font-weight: 600; }
  #emptyState .small { font-size: 12px; color: var(--text-faint); max-width: 320px; }

  /* toolbar inside graph */
  #graphToolbar {
    position: absolute; top: 12px; left: 12px; z-index: 10;
    display: flex; align-items: center; gap: 2px;
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 4px; box-shadow: var(--shadow);
  }
  #graphToolbar button {
    background: none; border: none; color: var(--text-dim); padding: 7px 10px; border-radius: var(--radius-sm);
    cursor: pointer; font-size: 11.5px; font-weight: 500; display: flex; align-items: center; gap: 5px;
  }
  #graphToolbar button:hover { background: var(--panel-2); color: var(--text); }
  #graphToolbar button.active { background: var(--accent-soft-2); color: var(--accent); }
  #graphToolbar button:disabled { opacity: 0.35; cursor: not-allowed; }
  #graphToolbar .tb-sep { width: 1px; height: 18px; background: var(--border); margin: 0 3px; }

  #graphLegend {
    position: absolute; bottom: 12px; left: 12px; z-index: 10;
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 10px 12px; box-shadow: var(--shadow);
    font-size: 11px; color: var(--text-dim); line-height: 1.8;
  }
  #graphLegend .leg-title { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-faint); margin-bottom: 4px; }
  #graphLegend .row { display: flex; align-items: center; gap: 7px; }
  #graphLegend .dot { width: 9px; height: 9px; border-radius: 50%; }
  #graphLegend .line { width: 16px; height: 0; border-top: 1.5px solid; display: inline-block; }

  #collapseFiltersBtn, #collapseDetailsBtn {
    position: absolute; top: 12px; z-index: 15; background: var(--panel); border: 1px solid var(--border);
    border-radius: var(--radius-sm); width: 24px; height: 24px; cursor: pointer; color: var(--text-dim);
    display: flex; align-items: center; justify-content: center; box-shadow: var(--shadow);
  }
  #collapseFiltersBtn { left: 12px; }
  #collapseDetailsBtn { right: 12px; }
  #body:not(.filters-collapsed) #collapseFiltersBtn { display: none; }
  #body:not(.details-collapsed) #collapseDetailsBtn { display: none; }

  /* ---------- RIGHT PANEL: TABS ---------- */
  #tabBar { display: flex; border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .tab-btn {
    flex: 1; background: none; border: none; padding: 11px 4px; font-size: 11.5px; font-weight: 600;
    color: var(--text-faint); cursor: pointer; border-bottom: 2px solid transparent;
  }
  .tab-btn:hover { color: var(--text); }
  .tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-content { display: none; padding: 14px; flex-direction: column; gap: 14px; overflow-y: auto; flex: 1; }
  .tab-content.active { display: flex; }

  #detailsEmpty { color: var(--text-faint); font-size: 12px; line-height: 1.6; padding: 14px; }
  .node-title { font-size: 15px; font-weight: 700; word-break: break-word; letter-spacing: -0.01em; }
  .node-type-badge {
    display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; padding: 2px 9px;
    border-radius: 999px; margin-top: 7px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  }
  .kv-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .kv-table tr { border-bottom: 1px solid var(--border-soft); }
  .kv-table td { padding: 7px 0; vertical-align: top; }
  .kv-table td:first-child { color: var(--text-dim); width: 42%; }
  .kv-table td:last-child { color: var(--text); word-break: break-word; font-weight: 500; }
  .sig-box {
    background: var(--panel-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 9px 10px; font-family: Consolas, Menlo, monospace; font-size: 11.5px; color: #2c3140;
    white-space: pre-wrap; word-break: break-word; margin-top: 6px;
  }

  /* analytics tab */
  .metric-card-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .metric-card {
    background: var(--panel-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 10px 12px;
  }
  .metric-card .mv { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .metric-card .ml { font-size: 10.5px; color: var(--text-dim); margin-top: 2px; }

  .bar-row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; margin-bottom: 7px; }
  .bar-row .bl { width: 76px; flex-shrink: 0; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { flex: 1; height: 7px; background: var(--border-soft); border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; background: var(--accent); }
  .bar-row .bv { width: 26px; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; font-weight: 600; color: var(--text); }

  .ring-wrap { display: flex; align-items: center; gap: 14px; }
  .ring-label { font-size: 11px; color: var(--text-dim); line-height: 1.7; }
  .ring-label b { color: var(--text); font-variant-numeric: tabular-nums; }

  /* relationships tab */
  .rel-group-title { font-size: 11px; font-weight: 700; color: var(--text); margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
  .rel-group-title .rcount { color: var(--text-faint); font-weight: 500; }
  .conn-list { display: flex; flex-direction: column; gap: 2px; margin-bottom: 12px; }
  .conn-item {
    display: flex; align-items: center; gap: 7px; padding: 7px 8px; border-radius: var(--radius-sm);
    cursor: pointer; font-size: 12px; border: 1px solid transparent;
  }
  .conn-item:hover { background: var(--panel-2); border-color: var(--border); }
  .conn-item .swatch { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .conn-item .dir { color: var(--text-faint); font-size: 10px; width: 14px; text-align: center; flex-shrink: 0; }
  .conn-item .n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .conn-item .p { color: var(--text-faint); font-size: 10px; }

  .btn-row { display: flex; gap: 8px; }
  .action-btn {
    flex: 1; background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
    border-radius: var(--radius-sm); padding: 8px 0; font-size: 11.5px; cursor: pointer; font-weight: 600;
  }
  .action-btn:hover { background: #f0f1f3; }
  .action-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .action-btn.danger { color: var(--danger); }

  /* ---------- STATUS BAR ---------- */
  #statusBar {
    display: flex; align-items: center; gap: 18px; padding: 7px 18px;
    background: var(--panel); border-top: 1px solid var(--border); font-size: 11px; color: var(--text-dim);
    z-index: 20; flex-wrap: wrap;
  }
  #statusBar b { color: var(--text); font-weight: 700; }
  #statusBar .sep { color: var(--border); }
  #statusBar .gen-at { margin-left: auto; color: var(--text-faint); }

  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: #d7dbe0; border-radius: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }

  .tooltip {
    position: fixed; z-index: 100; background: #1a1d24; color: #fff;
    border-radius: var(--radius-sm); padding: 8px 10px; font-size: 11.5px; max-width: 300px;
    pointer-events: none; box-shadow: 0 10px 24px rgba(0,0,0,0.35); display: none;
  }
  .tooltip .t-title { font-weight: 700; margin-bottom: 3px; }
  .tooltip .t-row { color: #c7c9ce; }
</style>
</head>
<body>
<div id="app">

  <div id="header">
    <div id="brand"><span class="mark"></span>Project Brain <span class="sub">Knowledge Graph</span></div>
    <div id="breadcrumb"></div>
    <select id="repoSelect"></select>
    <div id="searchWrap">
      <input id="searchBox" placeholder="Search by name, kind, or file..." autocomplete="off" />
      <div id="searchResults"></div>
    </div>
    <button class="hbtn" id="resetBtn">Reset graph</button>
    <select id="layoutSelect">
      <option value="galaxy" selected>Galaxy layout</option>
      <option value="concentric">Radial layout</option>
      <option value="cose">Force-directed layout</option>
      <option value="breadthfirst">Hierarchical layout</option>
    </select>
    <div id="headerRight">
      <div id="zoomGroup">
        <button id="zoomOutBtn" title="Zoom out">&minus;</button>
        <button id="zoomFitBtn" title="Fit view">&#9633;</button>
        <button id="zoomInBtn" title="Zoom in">+</button>
      </div>
      <button class="hbtn" id="fullscreenBtn">Fullscreen</button>
      <button class="hbtn" id="themeToggleBtn" title="Toggle dark mode">Dark mode</button>
    </div>
  </div>

  <div id="body">
    <div id="filters">
      <div class="filter-group" id="activeFiltersGroup" style="display:none;">
        <div class="panel-title">Active Filters</div>
        <div id="activeChips"></div>
        <button id="clearFiltersBtn">Clear all</button>
      </div>
      <div class="filter-group">
        <div class="panel-title">Node Type</div>
        <div id="typeFilters"></div>
      </div>
      <div class="filter-group">
        <div class="panel-title">File</div>
        <div id="fileFilters"></div>
      </div>
      <div class="filter-group">
        <div class="panel-title">Relationship Type</div>
        <div id="edgeFilters"></div>
      </div>
      <div class="filter-group">
        <div class="panel-title">Connections (degree)</div>
        <div class="range-row">
          <span>Min</span>
          <input type="range" id="degreeRange" min="0" max="1" value="0" step="1" />
          <span class="range-val" id="degreeVal">0</span>
        </div>
      </div>
      <div class="filter-group">
        <div class="panel-title">Exploration Depth</div>
        <div id="depthControl">
          <button data-depth="1" class="active">1</button>
          <button data-depth="2">2</button>
          <button data-depth="3">3</button>
          <button data-depth="4">4</button>
        </div>
        <div id="depthHint">Double-click a node, or use "Expand" in the toolbar, to reveal its callers/callees this many hops out.</div>
      </div>
    </div>

    <div id="graphWrap">
      <button id="collapseFiltersBtn" title="Show filters">&#8250;</button>
      <canvas id="starfield"></canvas>
      <div id="cy"></div>
      <div id="graphToolbar">
        <button id="tbFocus" title="Focus selected node">Focus</button>
        <button id="tbExpand" title="Expand neighborhood" disabled>Expand</button>
        <button id="tbCollapse" title="Collapse expanded neighborhood" disabled>Collapse</button>
        <button id="tbHighlight" title="Highlight selected node's connections" disabled>Highlight</button>
        <div class="tb-sep"></div>
        <button id="tbFit" title="Fit graph">Fit</button>
        <button id="tbZoomOut" title="Zoom out">&minus;</button>
        <button id="tbZoomIn" title="Zoom in">+</button>
      </div>
      <div id="emptyState">
        <div class="big" id="emptyBig">No nodes match the selected filters.</div>
        <div class="small" id="emptySmall">Try widening your Node Type, File, or Connections filters.</div>
        <button class="hbtn clear-link" id="emptyClearBtn">Clear filters</button>
      </div>
      <div id="graphLegend"></div>
      <button id="collapseDetailsBtn" title="Hide details">&#8250;</button>
    </div>

    <div id="detailsPanel">
      <div id="tabBar">
        <button class="tab-btn active" data-tab="details">Details</button>
        <button class="tab-btn" data-tab="analytics">Analytics</button>
        <button class="tab-btn" data-tab="relationships">Relationships</button>
      </div>
      <div class="tab-content active" id="tab-details">
        <div id="detailsEmpty">Select a node in the graph, or search above, to inspect its type, properties, and connections.</div>
      </div>
      <div class="tab-content" id="tab-analytics"></div>
      <div class="tab-content" id="tab-relationships"></div>
    </div>
  </div>

  <div id="statusBar">
    <span>Nodes: <b id="statNodes">0</b></span>
    <span class="sep">|</span>
    <span>Relationships: <b id="statEdges">0</b></span>
    <span class="sep">|</span>
    <span>Visible: <b id="statVisNodes">0</b></span>
    <span class="sep">|</span>
    <span>Filtered out: <b id="statFiltered">0</b></span>
    <span class="sep">|</span>
    <span>Selected: <b id="statSelected">none</b></span>
    <span class="sep">|</span>
    <span>Depth: <b id="statDepth">1</b></span>
    <span class="gen-at" id="genAt"></span>
  </div>
</div>

<div class="tooltip" id="tooltip"></div>

<script>
const REPO_DATA = /*__REPO_DATA__*/;
const GENERATED_AT = /*__GENERATED_AT__*/;

/**
 * Cytoscape's style engine takes raw hex, not CSS custom properties, so the
 * graph's colors are kept in this JS-side palette (mirroring the CSS
 * :root / [data-theme="dark"] tokens) instead of reading var(--x) - the
 * light/dark split has to be duplicated here rather than derived from CSS.
 */
const PALETTE = {
  light: {
    kind: { 'function': '#4361ee', 'method': '#d97706', 'class': '#059669' },
    kindFallback: '#6b7280',
    edge: '#c6cad2',
    edgeCrossFile: '#a9b4f5',
    nodeLabel: '#3a3f4b',
    nodeLabelOutline: '#f5f6f8',
    rootBorder: '#1a1d24',
    selectedBorder: '#7a1230',
    relatedEdge: '#7a1230',
    ringTrack: '#edeff2',
    ringFill: '#4361ee',
    ringText: '#1a1d24'
  },
  dark: {
    kind: { 'function': '#8b8bff', 'method': '#ffb454', 'class': '#4de8b0' },
    kindFallback: '#a79ecf',
    edge: '#453a6e',
    edgeCrossFile: '#9d7cf7',
    nodeLabel: '#ece9f7',
    nodeLabelOutline: '#0c0817',
    rootBorder: '#f4f1ff',
    selectedBorder: '#ff6ec7',
    relatedEdge: '#ff6ec7',
    ringTrack: '#241c40',
    ringFill: '#a78bfa',
    ringText: '#ece9f7'
  }
};

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
function palette() { return PALETTE[currentTheme()]; }
function colorForKind(k) { return palette().kind[k] || palette().kindFallback; }

let cy = null;
let currentRepo = null;
let selectedId = null;
let depth = 1;
let expandedIds = new Set();
let filters = { types: new Set(), files: new Set(), edgeKinds: new Set(), minDegree: 0 };
let allTypes = [], allFiles = [], allEdgeKinds = [];

const el = (id) => document.getElementById(id);
const repoSelect = el('repoSelect');
const searchBox = el('searchBox');
const searchResults = el('searchResults');
const tooltip = el('tooltip');
const bodyEl = el('body');

el('genAt').textContent = 'Generated ' + new Date(GENERATED_AT).toLocaleString();

/* ---------------- theme ---------------- */
const THEME_KEY = 'brain-graph-theme';
function applyTheme(theme, rebuild) {
  document.documentElement.setAttribute('data-theme', theme);
  el('themeToggleBtn').textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
  el('themeToggleBtn').classList.toggle('active', theme === 'dark');
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* storage unavailable */ }
  if (rebuild && cy) {
    const reselectId = selectedId;
    buildGraph();
    if (reselectId && cy.getElementById(reselectId).length) selectNode(reselectId);
  }
}
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* storage unavailable */ }
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'), false);
})();
el('themeToggleBtn').addEventListener('click', () => {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
});

/* ---------------- celestial starfield (dark mode only, CSS-hidden otherwise) ---------------- */
(function initStarfield() {
  const canvas = el('starfield');
  const ctx = canvas.getContext('2d');
  let stars = [];
  let w = 0, h = 0, t = 0, raf = null;

  function resize() {
    const wrap = el('graphWrap');
    w = canvas.width = wrap.clientWidth;
    h = canvas.height = wrap.clientHeight;
    const count = Math.floor((w * h) / 3200);
    stars = new Array(count).fill(0).map(() => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.1 + 0.3,
      phase: Math.random() * Math.PI * 2,
      speed: Math.random() * 0.02 + 0.006,
      hue: Math.random() < 0.18 ? (Math.random() < 0.5 ? '#c9b6ff' : '#ff9ecb') : '#ffffff'
    }));
  }

  function frame() {
    if (currentTheme() !== 'dark') { raf = requestAnimationFrame(frame); return; }
    ctx.clearRect(0, 0, w, h);
    t += 1;
    for (const s of stars) {
      const tw = 0.4 + 0.6 * Math.sin(t * s.speed + s.phase);
      ctx.globalAlpha = Math.max(0, tw);
      ctx.fillStyle = s.hue;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  resize();
  raf = requestAnimationFrame(frame);
})();

/* ---------------- repo bootstrap ---------------- */
Object.keys(REPO_DATA).forEach((repoId) => {
  const opt = document.createElement('option');
  opt.value = repoId;
  opt.textContent = repoId;
  repoSelect.appendChild(opt);
});
repoSelect.addEventListener('change', () => loadRepo(repoSelect.value));

function loadRepo(repoId) {
  const data = REPO_DATA[repoId];
  if (!data) return;
  currentRepo = data;
  selectedId = null;
  expandedIds = new Set();
  el('breadcrumb').textContent = data.rootDir;

  allTypes = uniq(data.nodes.map((n) => n.kind)).sort();
  allFiles = uniq(data.nodes.map((n) => n.path)).sort();
  allEdgeKinds = uniq(data.edges.map((e) => e.kind)).sort();

  filters = { types: new Set(allTypes), files: new Set(allFiles), edgeKinds: new Set(allEdgeKinds), minDegree: 0 };

  buildTypeFilters();
  buildFileFilters();
  buildEdgeFilters();
  buildDegreeRange();
  buildLegend();
  renderChips();
  showDetailsEmpty();

  buildGraph();
}

function uniq(arr) { return Array.from(new Set(arr)); }

/* ---------------- filter panel construction ---------------- */
function buildTypeFilters() {
  const wrap = el('typeFilters');
  wrap.innerHTML = '';
  allTypes.forEach((t) => {
    const count = currentRepo.nodes.filter((n) => n.kind === t).length;
    const row = document.createElement('label');
    row.className = 'chk-row';
    row.innerHTML = '<input type="checkbox" checked data-type="' + t + '" />' +
      '<span class="swatch" style="background:' + colorForKind(t) + '"></span>' +
      '<span class="lbl">' + t + '</span><span class="cnt">' + count + '</span>';
    row.querySelector('input').addEventListener('change', (e) => {
      toggleSetVal(filters.types, t, e.target.checked);
      applyFilters();
    });
    wrap.appendChild(row);
  });
}

function buildFileFilters() {
  const wrap = el('fileFilters');
  wrap.innerHTML = '';
  allFiles.forEach((f) => {
    const count = currentRepo.nodes.filter((n) => n.path === f).length;
    const row = document.createElement('label');
    row.className = 'chk-row';
    row.title = f;
    row.innerHTML = '<input type="checkbox" checked data-file="' + escapeAttr(f) + '" />' +
      '<span class="lbl">' + shortenPath(f) + '</span><span class="cnt">' + count + '</span>';
    row.querySelector('input').addEventListener('change', (e) => {
      toggleSetVal(filters.files, f, e.target.checked);
      applyFilters();
    });
    wrap.appendChild(row);
  });
}

function buildEdgeFilters() {
  const wrap = el('edgeFilters');
  wrap.innerHTML = '';
  if (!allEdgeKinds.length) {
    wrap.innerHTML = '<div style="color:var(--text-faint);font-size:11.5px;">No relationships available.</div>';
    return;
  }
  allEdgeKinds.forEach((k) => {
    const count = currentRepo.edges.filter((e) => e.kind === k).length;
    const row = document.createElement('label');
    row.className = 'chk-row';
    row.innerHTML = '<input type="checkbox" checked data-edge="' + k + '" />' +
      '<span class="lbl">' + k + '</span><span class="cnt">' + count + '</span>';
    row.querySelector('input').addEventListener('change', (e) => {
      toggleSetVal(filters.edgeKinds, k, e.target.checked);
      applyFilters();
    });
    wrap.appendChild(row);
  });
}

function buildDegreeRange() {
  const maxDeg = Math.max(1, ...currentRepo.nodes.map((n) => n.degree));
  const range = el('degreeRange');
  range.max = maxDeg;
  range.value = 0;
  el('degreeVal').textContent = '0';
  range.oninput = () => {
    filters.minDegree = Number(range.value);
    el('degreeVal').textContent = range.value;
    applyFilters();
  };
}

function buildLegend() {
  const wrap = el('graphLegend');
  let html = '<div class="leg-title">Legend</div>';
  allTypes.forEach((t) => {
    html += '<div class="row"><span class="dot" style="background:' + colorForKind(t) + '"></span>' + t + '</div>';
  });
  if (allEdgeKinds.includes('calls')) {
    html += '<div class="row"><span class="line" style="border-color:#9aa1ab"></span>calls</div>';
  }
  html += '<div class="row"><span class="line" style="border-color:#4361ee;border-top-width:2px"></span>cross-file</div>';
  wrap.innerHTML = html;
}

function toggleSetVal(set, val, on) { if (on) set.add(val); else set.delete(val); }
function escapeAttr(s) { return s.replace(/"/g, '&quot;'); }
function shortenPath(p) { return p.length > 34 ? '...' + p.slice(-31) : p; }

/* ---------------- active filter chips ---------------- */
function renderChips() {
  const chips = [];
  if (filters.types.size < allTypes.length) {
    chips.push({ label: 'Type: ' + (allTypes.filter((t) => filters.types.has(t)).join(', ') || 'none'), clear: () => { filters.types = new Set(allTypes); syncCheckboxes(); } });
  }
  if (filters.files.size < allFiles.length) {
    chips.push({ label: 'Files: ' + filters.files.size + '/' + allFiles.length, clear: () => { filters.files = new Set(allFiles); syncCheckboxes(); } });
  }
  if (filters.edgeKinds.size < allEdgeKinds.length) {
    chips.push({ label: 'Relationship: ' + (Array.from(filters.edgeKinds).join(', ') || 'none'), clear: () => { filters.edgeKinds = new Set(allEdgeKinds); syncCheckboxes(); } });
  }
  if (filters.minDegree > 0) {
    chips.push({ label: 'Min degree: ' + filters.minDegree, clear: () => { filters.minDegree = 0; el('degreeRange').value = 0; el('degreeVal').textContent = '0'; } });
  }
  const wrap = el('activeChips');
  const group = el('activeFiltersGroup');
  wrap.innerHTML = '';
  if (!chips.length) { group.style.display = 'none'; return; }
  group.style.display = 'block';
  chips.forEach((c) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = c.label + ' <button>&times;</button>';
    chip.querySelector('button').addEventListener('click', () => { c.clear(); applyFilters(); });
    wrap.appendChild(chip);
  });
}

function syncCheckboxes() {
  document.querySelectorAll('#typeFilters input').forEach((i) => i.checked = filters.types.has(i.dataset.type));
  document.querySelectorAll('#fileFilters input').forEach((i) => i.checked = filters.files.has(i.dataset.file));
  document.querySelectorAll('#edgeFilters input').forEach((i) => i.checked = filters.edgeKinds.has(i.dataset.edge));
}

el('clearFiltersBtn').addEventListener('click', clearAllFilters);
el('emptyClearBtn').addEventListener('click', clearAllFilters);
function clearAllFilters() {
  filters = { types: new Set(allTypes), files: new Set(allFiles), edgeKinds: new Set(allEdgeKinds), minDegree: 0 };
  el('degreeRange').value = 0;
  el('degreeVal').textContent = '0';
  syncCheckboxes();
  applyFilters();
}

/* ---------------- collapse panels ---------------- */
el('collapseFiltersBtn').addEventListener('click', () => bodyEl.classList.remove('filters-collapsed'));
el('collapseDetailsBtn').addEventListener('click', () => bodyEl.classList.remove('details-collapsed'));

/* ---------------- tabs ---------------- */
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    btn.classList.add('active');
    el('tab-' + btn.dataset.tab).classList.add('active');
  });
});

/* ---------------- cytoscape graph ---------------- */
function nodeSize(n) {
  const maxDeg = Math.max(1, ...currentRepo.nodes.map((x) => x.degree));
  const t = Math.sqrt(n.degree / maxDeg);
  return 14 + t * 26;
}

function buildGraph() {
  if (cy) cy.destroy();

  const elements = [];
  currentRepo.nodes.forEach((n) => {
    elements.push({ data: { id: n.id, label: n.label, kind: n.kind, path: n.path, className: n.className, startLine: n.startLine, endLine: n.endLine, signature: n.signature, degree: n.degree, inDegree: n.inDegree, outDegree: n.outDegree } });
  });
  currentRepo.edges.forEach((e) => {
    elements.push({ data: { id: e.id, source: e.source, target: e.target, kind: e.kind, crossFile: e.crossFile } });
  });

  cy = cytoscape({
    container: el('cy'),
    elements,
    minZoom: 0.005,
    maxZoom: 6,
    style: [
      { selector: 'node', style: {
          'background-color': (ele) => colorForKind(ele.data('kind')),
          'width': (ele) => nodeSize(ele.data()),
          'height': (ele) => nodeSize(ele.data()),
          'label': 'data(label)',
          'font-size': 9,
          'color': () => palette().nodeLabel,
          'text-valign': 'bottom',
          'text-margin-y': 4,
          'text-outline-width': 2,
          'text-outline-color': () => palette().nodeLabelOutline,
          'border-width': 0,
          'transition-property': 'opacity, border-width, background-color',
          'transition-duration': 120
        } },
      { selector: 'edge', style: {
          'width': 1.1,
          'line-color': () => palette().edge,
          'target-arrow-color': () => palette().edge,
          'target-arrow-shape': 'triangle',
          'arrow-scale': 0.65,
          'curve-style': 'bezier',
          'opacity': 0.65,
          'z-index': 5
        } },
      { selector: 'edge[?crossFile]', style: {
          'line-color': () => palette().edgeCrossFile,
          'target-arrow-color': () => palette().edgeCrossFile,
          'width': 1.6, 'opacity': 0.85
        } },
      { selector: 'node.root', style: { 'border-width': 3, 'border-color': () => palette().rootBorder, 'border-opacity': 0.9, 'z-index': 999 } },
      { selector: 'node.selected', style: { 'border-width': 3, 'border-color': () => palette().selectedBorder, 'z-index': 999 } },
      { selector: 'node.neighbor', style: { 'z-index': 900 } },
      { selector: 'edge.related', style: {
          'line-color': () => palette().relatedEdge,
          'target-arrow-color': () => palette().relatedEdge,
          'opacity': 1, 'width': 2.6, 'z-index': 998
        } },
      { selector: '.dimmed', style: { 'opacity': 0.08 } },
      { selector: '.hidden-filtered', style: { 'display': 'none' } }
    ],
    layout: layoutOpts('galaxy')
  });

  cy.on('tap', 'node', (evt) => selectNode(evt.target.id()));
  cy.on('tap', (evt) => { if (evt.target === cy) deselectAll(); });
  cy.on('dblclick', 'node', (evt) => expandNode(evt.target.id()));
  cy.on('mouseover', 'node', (evt) => showTooltip(evt));
  cy.on('mouseout', 'node', () => { tooltip.style.display = 'none'; });
  cy.on('mousemove', 'node', (evt) => positionTooltip(evt));

  applyFilters();
  updateStats();
  cy.fit(undefined, 40);
}

/**
 * Cytoscape's concentric layout treats each distinct concentric() value as
 * its own ring; feeding it raw degree (which can range 0-30+ across 800+
 * nodes) produces dozens of sparse rings and blows the layout radius out to
 * tens of thousands of px. Bucketing degree into a handful of rings keeps
 * "higher degree = closer to center" while giving the layout a compact,
 * genuinely radial shape.
 */
function degreeBucket(deg, maxDeg) {
  if (maxDeg <= 0) return 0;
  const RINGS = 6;
  const t = deg / maxDeg;
  return Math.round(t * (RINGS - 1));
}

function layoutOpts(name) {
  if (name === 'cose') {
    return { name: 'cose', animate: false, fit: true, padding: 40, nodeRepulsion: 9000, idealEdgeLength: 60, gravity: 0.3 };
  }
  if (name === 'breadthfirst') {
    return { name: 'breadthfirst', animate: false, fit: true, padding: 40, spacingFactor: 0.9, directed: true };
  }
  if (name === 'concentric') {
    const maxDeg = Math.max(1, ...currentRepo.nodes.map((n) => n.degree));
    return {
      name: 'concentric',
      animate: false,
      minNodeSpacing: 10,
      concentric: (n) => (n.hasClass('root') ? 999 : degreeBucket(n.data('degree') || 0, maxDeg)),
      levelWidth: () => 1,
      equidistant: false,
      fit: true,
      padding: 40
    };
  }
  return galaxyLayoutOpts();
}

/**
 * "Galaxy" layout: each file becomes its own star cluster instead of every
 * node sharing one global ring. Cluster anchor points are scattered across
 * a wide canvas (not one tight circle) using a golden-angle spiral, sized
 * by how many symbols the file has so big files claim more room; nodes
 * within a file start as a small preset scatter around their anchor. Cose
 * then runs from those seeded positions with light gravity so it locally
 * untangles each cluster and separates overlapping clusters, without
 * collapsing everything back into one central blob the way an unseeded
 * force layout (or a single concentric ring) would.
 */
function galaxyLayoutOpts() {
  const files = uniq(currentRepo.nodes.map((n) => n.path));
  const countByFile = new Map();
  currentRepo.nodes.forEach((n) => countByFile.set(n.path, (countByFile.get(n.path) || 0) + 1));

  const totalNodes = currentRepo.nodes.length;
  const galaxyRadius = 340 + Math.sqrt(totalNodes) * 90;
  const golden = Math.PI * (3 - Math.sqrt(5));

  const anchors = new Map();
  files.forEach((f, i) => {
    const t = files.length > 1 ? i / (files.length - 1) : 0;
    const r = galaxyRadius * Math.sqrt(t);
    const theta = i * golden;
    anchors.set(f, { x: r * Math.cos(theta), y: r * Math.sin(theta) });
  });

  // Sunflower (Vogel) spiral per cluster: radius grows with sqrt(index) so
  // points fill the disc with even density and never overlap, regardless
  // of how many symbols the file has - unlike a modulo-wrapped spiral,
  // which recycles small radii and clumps nodes once a file passes ~40
  // symbols.
  const positions = {};
  const seenPerFile = new Map();
  const NODE_GAP = 30;
  currentRepo.nodes.forEach((n) => {
    const anchor = anchors.get(n.path);
    const idx = seenPerFile.get(n.path) || 0;
    seenPerFile.set(n.path, idx + 1);
    const a = idx * golden;
    const rr = NODE_GAP * Math.sqrt(idx + 1);
    positions[n.id] = { x: anchor.x + rr * Math.cos(a), y: anchor.y + rr * Math.sin(a) };
  });

  return {
    name: 'preset',
    positions,
    fit: true,
    padding: 60,
    animate: false
  };
}

el('layoutSelect').addEventListener('change', () => {
  if (!cy) return;
  cy.layout(layoutOpts(el('layoutSelect').value)).run();
});

/* ---------------- filtering ---------------- */
function applyFilters() {
  if (!cy) return;
  renderChips();

  cy.nodes().forEach((n) => {
    const d = n.data();
    const visible = filters.types.has(d.kind) && filters.files.has(d.path) && d.degree >= filters.minDegree;
    n.toggleClass('hidden-filtered', !visible);
  });
  cy.edges().forEach((e) => {
    const d = e.data();
    const kindOk = filters.edgeKinds.has(d.kind);
    const endsVisible = !cy.getElementById(d.source).hasClass('hidden-filtered') && !cy.getElementById(d.target).hasClass('hidden-filtered');
    e.toggleClass('hidden-filtered', !(kindOk && endsVisible));
  });

  const visNodes = cy.nodes().not('.hidden-filtered');
  const visEdges = cy.edges().not('.hidden-filtered');

  el('emptyState').classList.toggle('show', visNodes.length === 0);

  updateStats(visNodes.length, visEdges.length);

  if (selectedId && cy.getElementById(selectedId).hasClass('hidden-filtered')) {
    deselectAll();
  }
}

function updateStats(visNodes, visEdges) {
  const total = currentRepo.nodes.length;
  const vis = visNodes != null ? visNodes : total;
  el('statNodes').textContent = total;
  el('statEdges').textContent = currentRepo.edges.length;
  el('statVisNodes').textContent = vis;
  el('statFiltered').textContent = total - vis;
  el('statDepth').textContent = depth;
}

/* ---------------- selection / details ---------------- */
function selectNode(id) {
  selectedId = id;
  const node = cy.getElementById(id);
  cy.elements().removeClass('root selected neighbor related');

  node.addClass('root selected');
  const neighborhood = node.closedNeighborhood();
  neighborhood.nodes().addClass('neighbor');
  node.connectedEdges().addClass('related');

  cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1.1) }, { duration: 250 });

  el('tbExpand').disabled = false;
  el('tbHighlight').disabled = false;
  el('tbCollapse').disabled = !expandedIds.has(id);

  renderDetailsTab(node);
  renderAnalyticsTab(node);
  renderRelationshipsTab(node);
  el('statSelected').textContent = node.data('label');
}

function deselectAll() {
  selectedId = null;
  if (cy) cy.elements().removeClass('root selected neighbor related dimmed');
  el('statSelected').textContent = 'none';
  el('tbExpand').disabled = true;
  el('tbCollapse').disabled = true;
  el('tbHighlight').disabled = true;
  showDetailsEmpty();
  el('tab-analytics').innerHTML = '';
  el('tab-relationships').innerHTML = '';
}

function showDetailsEmpty() {
  el('tab-details').innerHTML = '<div id="detailsEmpty">Select a node in the graph, or search above, to inspect its type, properties, and connections.</div>';
}

/* ----- Details tab ----- */
function renderDetailsTab(node) {
  const d = node.data();
  let html = '';
  html += '<div><div class="node-title">' + escapeHtml(d.label) + '</div>';
  html += '<div class="node-type-badge" style="background:' + colorForKind(d.kind) + '1a;color:' + colorForKind(d.kind) + ';border:1px solid ' + colorForKind(d.kind) + '44;">' + d.kind + '</div></div>';

  html += '<table class="kv-table">';
  html += kvRow('ID', d.id);
  html += kvRow('File', d.path);
  if (d.className) html += kvRow('Enclosing class', d.className);
  html += kvRow('Lines', d.startLine + '–' + d.endLine);
  html += kvRow('Connections (degree)', d.degree);
  html += '</table>';

  if (d.signature) {
    html += '<div><div class="panel-title" style="margin-bottom:6px;">Signature</div>';
    html += '<div class="sig-box">' + escapeHtml(d.signature) + '</div></div>';
  }

  html += '<div class="btn-row">';
  html += '<button class="action-btn primary" id="dExpandBtn">Expand connections</button>';
  html += '<button class="action-btn" id="dClearSelBtn">Deselect</button>';
  html += '</div>';

  el('tab-details').innerHTML = html;
  el('dExpandBtn').addEventListener('click', () => expandNode(d.id));
  el('dClearSelBtn').addEventListener('click', deselectAll);
}

function kvRow(k, v) { return '<tr><td>' + k + '</td><td>' + escapeHtml(String(v)) + '</td></tr>'; }

/* ----- Analytics tab (only real, derivable metrics) ----- */
function renderAnalyticsTab(node) {
  const d = node.data();
  const incoming = node.incomers('edge').not('.hidden-filtered');
  const outgoing = node.outgoers('edge').not('.hidden-filtered');
  const neighborhood = node.closedNeighborhood().nodes().not('.hidden-filtered');
  const total = incoming.length + outgoing.length;

  const kindsBreakdown = {};
  neighborhood.forEach((n) => { if (n.id() !== d.id) kindsBreakdown[n.data('kind')] = (kindsBreakdown[n.data('kind')] || 0) + 1; });

  let html = '';
  html += '<div><div class="panel-title">Connection Overview</div>';
  html += '<div class="metric-card-row">';
  html += metricCard(total, 'Total connections');
  html += metricCard(d.inDegree, 'Incoming (callers)');
  html += metricCard(d.outDegree, 'Outgoing (callees)');
  html += metricCard(neighborhood.length - 1, 'Neighborhood size');
  html += '</div></div>';

  html += '<div><div class="panel-title">In / Out Ratio</div>';
  const maxIO = Math.max(1, d.inDegree, d.outDegree);
  html += barRow('Incoming', d.inDegree, maxIO);
  html += barRow('Outgoing', d.outDegree, maxIO);
  html += '</div>';

  if (Object.keys(kindsBreakdown).length) {
    html += '<div><div class="panel-title">Neighborhood by Type</div>';
    const maxK = Math.max(1, ...Object.values(kindsBreakdown));
    Object.keys(kindsBreakdown).sort().forEach((k) => {
      html += barRow(k, kindsBreakdown[k], maxK, colorForKind(k));
    });
    html += '</div>';
  }

  const maxDegAll = Math.max(1, ...currentRepo.nodes.map((n) => n.degree));
  const pct = Math.round((d.degree / maxDegAll) * 100);
  html += '<div><div class="panel-title">Relative Connectivity</div>';
  html += '<div class="ring-wrap">' + ringSvg(pct) + '<div class="ring-label">This node has more connections than roughly<br/><b>' + pct + '%</b> of the busiest node in this graph.</div></div></div>';

  el('tab-analytics').innerHTML = html;
}

function metricCard(value, label) {
  return '<div class="metric-card"><div class="mv">' + value + '</div><div class="ml">' + label + '</div></div>';
}

function barRow(label, value, max, color) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return '<div class="bar-row"><span class="bl">' + escapeHtml(label) + '</span>' +
    '<span class="bar-track"><span class="bar-fill" style="width:' + pct + '%;' + (color ? 'background:' + color + ';' : '') + '"></span></span>' +
    '<span class="bv">' + value + '</span></div>';
}

function ringSvg(pct) {
  const r = 26, c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  const p = palette();
  return '<svg width="64" height="64" viewBox="0 0 64 64">' +
    '<circle cx="32" cy="32" r="' + r + '" fill="none" stroke="' + p.ringTrack + '" stroke-width="7"/>' +
    '<circle cx="32" cy="32" r="' + r + '" fill="none" stroke="' + p.ringFill + '" stroke-width="7" stroke-linecap="round" ' +
    'stroke-dasharray="' + c + '" stroke-dashoffset="' + offset + '" transform="rotate(-90 32 32)"/>' +
    '<text x="32" y="37" text-anchor="middle" font-size="14" font-weight="700" fill="' + p.ringText + '">' + pct + '%</text>' +
    '</svg>';
}

/* ----- Relationships tab (grouped by actual relationship type) ----- */
function renderRelationshipsTab(node) {
  const incoming = node.incomers('edge').not('.hidden-filtered');
  const outgoing = node.outgoers('edge').not('.hidden-filtered');

  if (incoming.length + outgoing.length === 0) {
    el('tab-relationships').innerHTML = '<div style="color:var(--text-faint);font-size:12px;">No relationships available.</div>';
    return;
  }

  const byKind = {};
  incoming.forEach((e) => {
    const k = e.data('kind');
    (byKind[k] = byKind[k] || { incoming: [], outgoing: [] }).incoming.push(e.source());
  });
  outgoing.forEach((e) => {
    const k = e.data('kind');
    (byKind[k] = byKind[k] || { incoming: [], outgoing: [] }).outgoing.push(e.target());
  });

  let html = '';
  Object.keys(byKind).sort().forEach((k) => {
    const group = byKind[k];
    const count = group.incoming.length + group.outgoing.length;
    html += '<div><div class="rel-group-title">' + k + ' <span class="rcount">(' + count + ')</span></div>';
    html += '<div class="conn-list">';
    group.incoming.forEach((n) => { html += connRowHtml(n, '←'); });
    group.outgoing.forEach((n) => { html += connRowHtml(n, '→'); });
    html += '</div></div>';
  });

  el('tab-relationships').innerHTML = html;
  el('tab-relationships').querySelectorAll('.conn-item').forEach((row) => {
    row.addEventListener('click', () => selectNode(row.dataset.id));
  });
}

function connRowHtml(otherNode, dirArrow) {
  const dd = otherNode.data();
  return '<div class="conn-item" data-id="' + dd.id + '">' +
    '<span class="dir">' + dirArrow + '</span>' +
    '<span class="swatch" style="background:' + colorForKind(dd.kind) + '"></span>' +
    '<span class="n">' + escapeHtml(dd.label) + '</span>' +
    '<span class="p">' + shortenPath(dd.path) + '</span></div>';
}

function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/* ---------------- depth-based expand / collapse (uses real edges already in the exported graph) ---------------- */
document.querySelectorAll('#depthControl button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#depthControl button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    depth = Number(btn.dataset.depth);
    el('statDepth').textContent = depth;
  });
});

function expandNode(id) {
  if (!cy) return;
  const start = cy.getElementById(id);
  if (!start.length) return;

  let frontier = start;
  let collected = start;
  for (let h = 0; h < depth; h++) {
    const next = frontier.closedNeighborhood();
    collected = collected.union(next);
    frontier = next;
  }

  collected.nodes().forEach((n) => filters.files.add(n.data('path')));
  syncCheckboxes();
  applyFilters();
  expandedIds.add(id);
  el('tbCollapse').disabled = false;

  cy.animate({ fit: { eles: collected, padding: 60 } }, { duration: 300 });
  selectNode(id);
}

function collapseNode(id) {
  if (!cy) return;
  expandedIds.delete(id);
  el('tbCollapse').disabled = true;
  cy.animate({ center: { eles: cy.getElementById(id) }, zoom: 1.2 }, { duration: 250 });
}

/* ---------------- graph toolbar ---------------- */
let focusMode = false;
el('tbFocus').addEventListener('click', () => {
  focusMode = !focusMode;
  el('tbFocus').classList.toggle('active', focusMode);
  if (!cy) return;
  if (!focusMode) { cy.elements().removeClass('dimmed'); return; }
  if (!selectedId) return;
  const node = cy.getElementById(selectedId);
  const neighborhood = node.closedNeighborhood();
  cy.elements().addClass('dimmed');
  neighborhood.removeClass('dimmed');
});
el('tbExpand').addEventListener('click', () => { if (selectedId) expandNode(selectedId); });
el('tbCollapse').addEventListener('click', () => { if (selectedId) collapseNode(selectedId); });
let highlightOn = false;
el('tbHighlight').addEventListener('click', () => {
  highlightOn = !highlightOn;
  el('tbHighlight').classList.toggle('active', highlightOn);
  if (!cy || !selectedId) return;
  const node = cy.getElementById(selectedId);
  if (highlightOn) {
    node.connectedEdges().addClass('related');
    node.closedNeighborhood().nodes().addClass('neighbor');
  } else {
    cy.elements().removeClass('related neighbor');
    node.addClass('root selected');
  }
});
el('tbFit').addEventListener('click', () => { if (cy) cy.animate({ fit: { padding: 40 } }, { duration: 200 }); });
el('tbZoomIn').addEventListener('click', () => { if (cy) cy.animate({ zoom: cy.zoom() * 1.3 }, { duration: 150 }); });
el('tbZoomOut').addEventListener('click', () => { if (cy) cy.animate({ zoom: cy.zoom() / 1.3 }, { duration: 150 }); });

/* ---------------- search ---------------- */
searchBox.addEventListener('input', () => {
  const term = searchBox.value.trim().toLowerCase();
  if (!term || !currentRepo) { searchResults.classList.remove('open'); return; }
  const matches = currentRepo.nodes.filter((n) =>
    n.label.toLowerCase().includes(term) ||
    n.kind.toLowerCase().includes(term) ||
    n.path.toLowerCase().includes(term) ||
    String(n.id).toLowerCase().includes(term)
  ).slice(0, 30);

  searchResults.innerHTML = '';
  if (!matches.length) {
    searchResults.innerHTML = '<div class="empty">No matching nodes found.</div>';
  } else {
    matches.forEach((n) => {
      const row = document.createElement('div');
      row.className = 'res-item';
      row.innerHTML = '<span class="k" style="background:' + colorForKind(n.kind) + '"></span>' +
        '<span class="n">' + escapeHtml(n.label) + '</span><span class="p">' + shortenPath(n.path) + '</span>';
      row.addEventListener('click', () => {
        searchResults.classList.remove('open');
        searchBox.value = n.label;
        clearAllFilters();
        selectNode(n.id);
      });
      searchResults.appendChild(row);
    });
  }
  searchResults.classList.add('open');
});
document.addEventListener('click', (e) => {
  if (!searchResults.contains(e.target) && e.target !== searchBox) searchResults.classList.remove('open');
});

/* ---------------- header controls ---------------- */
el('resetBtn').addEventListener('click', () => { if (currentRepo) loadRepo(currentRepo.repoId); });
el('zoomInBtn').addEventListener('click', () => { if (cy) cy.animate({ zoom: cy.zoom() * 1.3 }, { duration: 150 }); });
el('zoomOutBtn').addEventListener('click', () => { if (cy) cy.animate({ zoom: cy.zoom() / 1.3 }, { duration: 150 }); });
el('zoomFitBtn').addEventListener('click', () => { if (cy) cy.animate({ fit: { padding: 40 } }, { duration: 200 }); });
el('fullscreenBtn').addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
});

/* ---------------- tooltip ---------------- */
function showTooltip(evt) {
  const d = evt.target.data();
  tooltip.innerHTML = '<div class="t-title">' + escapeHtml(d.label) + '</div>' +
    '<div class="t-row">' + d.kind + (d.className ? ' in ' + escapeHtml(d.className) : '') + '</div>' +
    '<div class="t-row">' + escapeHtml(d.path) + ':' + d.startLine + '</div>' +
    '<div class="t-row">Connections: ' + d.degree + '</div>';
  tooltip.style.display = 'block';
  positionTooltip(evt);
}
function positionTooltip(evt) {
  const oe = evt.originalEvent;
  tooltip.style.left = (oe.clientX + 14) + 'px';
  tooltip.style.top = (oe.clientY + 14) + 'px';
}

/* ---------------- boot ---------------- */
if (Object.keys(REPO_DATA).length) {
  loadRepo(Object.keys(REPO_DATA)[0]);
} else {
  document.getElementById('cy').innerHTML = '<div style="padding:40px;color:#6b7280">No repos indexed yet. Run <code>brain build</code> inside a repo first, then <code>brain visualize3</code> again.</div>';
}
</script>
</body>
</html>
`;

module.exports = { generateVisualizationHtml3, buildRadialGraph };
