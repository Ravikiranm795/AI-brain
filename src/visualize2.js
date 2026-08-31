'use strict';

const fs = require('fs');
const path = require('path');
const { GraphStore } = require('./graphStore');
const { listAllRepoBrains } = require('./config');
const { buildCytoscapeElements } = require('./visualize');

function generateVisualizationHtml2(outPath) {
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
<title>Project Brain - Galaxy Viewer</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/layout-base@2.0.1/layout-base.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cose-base@2.2.0/cose-base.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-fcose@2.2.0/cytoscape-fcose.js"></script>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #010204; font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #e6e6e6; overflow: hidden; }

  #starfield { position: absolute; inset: 0; z-index: 0; }

  #topbar {
    position: relative; z-index: 2;
    display: flex; gap: 12px; align-items: center; padding: 10px 14px;
    background: rgba(10, 8, 20, 0.55); backdrop-filter: blur(10px);
    border-bottom: 1px solid rgba(140, 130, 255, 0.18); flex-wrap: wrap;
  }
  #topbar select, #topbar input {
    background: rgba(10, 8, 24, 0.7); color: #e8e6ff;
    border: 1px solid rgba(140, 130, 255, 0.3); border-radius: 8px;
    padding: 6px 10px; font-size: 13px;
  }
  #topbar input { width: 280px; }
  #topbar input::placeholder { color: #7b76a8; }
  #topbar .stat { font-size: 12px; color: #9d97cf; margin-left: auto; }
  #topbar button {
    background: rgba(120, 90, 255, 0.12); color: #e8e6ff;
    border: 1px solid rgba(140, 130, 255, 0.3); border-radius: 8px;
    padding: 6px 12px; font-size: 12px; cursor: pointer; transition: all 0.15s ease;
  }
  #topbar button:hover { background: rgba(140, 110, 255, 0.28); box-shadow: 0 0 12px rgba(140, 110, 255, 0.35); }
  #topbar button.active { background: linear-gradient(135deg, #7b5cff, #ff6ec7); border-color: transparent; color: #fff; }

  #cy { position: absolute; top: 46px; left: 0; right: 0; bottom: 0; z-index: 1; background: transparent; }

  .legend {
    position: absolute; bottom: 14px; left: 14px; z-index: 2;
    font-size: 11px; color: #b3aee0;
    background: rgba(10, 8, 24, 0.6); backdrop-filter: blur(8px);
    padding: 10px 12px; border-radius: 10px; line-height: 1.7;
    border: 1px solid rgba(140, 130, 255, 0.18);
  }
  .legend .dot {
    display: inline-block; width: 9px; height: 9px; border-radius: 50%;
    margin-right: 6px; vertical-align: middle;
  }
  .legend .ring {
    display: inline-block; width: 11px; height: 11px; border-radius: 50%;
    margin-right: 6px; vertical-align: middle; border: 1px solid;
  }

  #title {
    position: absolute; top: 56px; right: 18px; z-index: 2;
    font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
    color: #7b76a8; pointer-events: none;
  }
</style>
</head>
<body>
<canvas id="starfield"></canvas>
<div id="topbar">
  <select id="repoSelect"></select>
  <input id="searchBox" placeholder="Search a function, class, or file name..." />
  <button id="fitBtn">Fit view</button>
  <button id="relayoutBtn">Re-layout</button>
  <button id="crossFileBtn">Show cross-file links only</button>
  <div class="stat" id="stat"></div>
</div>
<div id="cy"></div>
<div id="title">Galaxy View</div>
<div class="legend">
  <div><span class="dot" style="background:#7fb8ff;box-shadow:0 0 6px #7fb8ff"></span>function</div>
  <div><span class="dot" style="background:#ffcf6e;box-shadow:0 0 6px #ffcf6e"></span>method</div>
  <div><span class="dot" style="background:#7dffb0;box-shadow:0 0 6px #7dffb0"></span>class</div>
  <div><span class="ring" style="border-color:#6f63b8"></span>file (cluster)</div>
  <div><span class="ring" style="border-color:#8f7fd6"></span>class (cluster)</div>
</div>
<script>
if (typeof cytoscapeFcose !== 'undefined') {
  cytoscape.use(cytoscapeFcose);
}

/* ---------- ambient starfield background (pure canvas, no deps) ---------- */
(function () {
  const canvas = document.getElementById('starfield');
  const ctx = canvas.getContext('2d');
  let stars = [];
  let w = 0, h = 0;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    const count = Math.floor((w * h) / 2600);
    stars = new Array(count).fill(0).map(() => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.2 + 0.2,
      phase: Math.random() * Math.PI * 2,
      speed: Math.random() * 0.015 + 0.004,
      hue: Math.random() < 0.15 ? (Math.random() < 0.5 ? '#c9b6ff' : '#ffd9a0') : '#ffffff'
    }));
  }

  function drawNebula() {
    const g1 = ctx.createRadialGradient(w * 0.2, h * 0.15, 0, w * 0.2, h * 0.15, w * 0.55);
    g1.addColorStop(0, 'rgba(80, 40, 140, 0.20)');
    g1.addColorStop(1, 'rgba(80, 40, 140, 0)');
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, w, h);

    const g2 = ctx.createRadialGradient(w * 0.85, h * 0.8, 0, w * 0.85, h * 0.8, w * 0.5);
    g2.addColorStop(0, 'rgba(30, 60, 130, 0.18)');
    g2.addColorStop(1, 'rgba(30, 60, 130, 0)');
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, w, h);
  }

  let t = 0;
  function frame() {
    ctx.fillStyle = '#010204';
    ctx.fillRect(0, 0, w, h);
    drawNebula();
    t += 1;
    for (const s of stars) {
      const tw = 0.55 + 0.45 * Math.sin(t * s.speed + s.phase);
      ctx.globalAlpha = tw;
      ctx.fillStyle = s.hue;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);
})();

/* ---------- graph ---------- */
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
  if (kind === 'class') return '#7dffb0';
  if (kind === 'method') return '#ffcf6e';
  return '#7fb8ff';
}

const LAYOUT_OPTS = {
  name: 'fcose',
  animate: false,
  quality: 'proof',
  randomize: false,
  nodeDimensionsIncludeLabels: true,
  packComponents: true,
  nodeRepulsion: 11000,
  idealEdgeLength: 110,
  edgeElasticity: 0.25,
  nestingFactor: 0.08,
  gravity: 0.1,
  gravityRangeCompound: 1.8,
  gravityCompound: 1.0,
  tile: true,
  tilingPaddingVertical: 70,
  tilingPaddingHorizontal: 70,
  componentSpacing: 200
};

function loadRepo(repoId) {
  const data = REPO_DATA[repoId];
  if (!data) return;
  if (cy) cy.destroy();

  cy = cytoscape({
    container: document.getElementById('cy'),
    elements: data.elements,
    style: [
      // File clusters - soft glowing "nebula" regions instead of boxes
      { selector: 'node[container = "file"]', style: {
          'shape': 'ellipse',
          'background-color': '#241a3d',
          'background-opacity': 0.35,
          'border-width': 1,
          'border-color': '#6f63b8',
          'border-opacity': 0.55,
          'label': 'data(label)',
          'font-size': 10,
          'font-weight': 600,
          'color': '#b3aee0',
          'text-valign': 'top',
          'text-halign': 'center',
          'text-margin-y': -16,
          'padding': 34,
          'shadow-blur': 24,
          'shadow-color': '#5b3fd6',
          'shadow-opacity': 0.35
        } },
      // Class clusters nested inside a file region
      { selector: 'node[container = "class"]', style: {
          'shape': 'ellipse',
          'background-color': '#2c2350',
          'background-opacity': 0.4,
          'border-width': 1,
          'border-color': '#8f7fd6',
          'border-opacity': 0.6,
          'label': 'data(label)',
          'font-size': 9,
          'font-weight': 600,
          'color': '#7dffb0',
          'text-valign': 'top',
          'text-halign': 'center',
          'text-margin-y': -10,
          'padding': 22
        } },
      // Leaf symbol nodes - stars, glowing by kind
      { selector: 'node[!container]', style: {
          'background-color': (ele) => colorFor(ele.data('kind')),
          'label': 'data(label)',
          'font-size': 8,
          'color': '#e8e6ff',
          'width': 10,
          'height': 10,
          'shape': 'ellipse',
          'text-valign': 'bottom',
          'text-margin-y': 3,
          'shadow-blur': 14,
          'shadow-color': (ele) => colorFor(ele.data('kind')),
          'shadow-opacity': 0.85
        } },
      // Edges - faint starlight trails
      { selector: 'edge', style: {
          'width': 1,
          'line-color': '#5b5590',
          'target-arrow-color': '#5b5590',
          'target-arrow-shape': 'triangle',
          'arrow-scale': 0.7,
          'curve-style': 'bezier',
          'opacity': 0.35,
          'z-index': 10
        } },
      // Cross-file edges - brighter "constellation lines"
      { selector: 'edge[?crossFile]', style: {
          'line-color': '#c9b6ff',
          'width': 1.4,
          'opacity': 0.65,
          'shadow-blur': 6,
          'shadow-color': '#c9b6ff',
          'shadow-opacity': 0.4
        } },
      { selector: 'node[!container].highlighted', style: {
          'background-color': '#ff6ec7',
          'shadow-color': '#ff6ec7',
          'shadow-blur': 26,
          'shadow-opacity': 1,
          'opacity': 1,
          'width': 15,
          'height': 15,
          'z-index': 999
        } },
      { selector: 'node[?container].highlighted', style: {
          'border-color': '#ff6ec7',
          'border-width': 2.5,
          'border-opacity': 1,
          'opacity': 1,
          'z-index': 999
        } },
      { selector: 'edge.highlighted', style: {
          'line-color': '#ff6ec7', 'target-arrow-color': '#ff6ec7',
          'opacity': 1, 'width': 2.2, 'z-index': 999,
          'shadow-blur': 10, 'shadow-color': '#ff6ec7', 'shadow-opacity': 0.8
        } },
      { selector: '.dimmed', style: { 'opacity': 0.04 } }
    ],
    layout: LAYOUT_OPTS
  });

  const leafCount = data.elements.filter((e) => e.data && !e.data.source && !e.data.container).length;
  const edgeCount = data.elements.filter((e) => e.data && e.data.source).length;
  statEl.textContent = leafCount + ' stars, ' + edgeCount + ' constellation links, grouped by file/class — ' + data.rootDir;

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
  document.getElementById('cy').innerHTML = '<div style="padding:40px;color:#9d97cf">No repos indexed yet. Run <code>brain build</code> inside a repo first, then <code>brain visualize2</code> again.</div>';
}
</script>
</body>
</html>
`;

module.exports = { generateVisualizationHtml2 };
