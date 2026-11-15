'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/viewer/core');

// symbols: [id, fileIdx, name, kind, startLine, endLine, signature]; edges flat [src, dst, res]
function snap({ files, symbols, edges = [] }) {
  return { files, symbols, edges, resolutions: ['heuristic', 'lsp'] };
}

function small() {
  return snap({
    files: [['src/a/Svc.java', '.java', 0], ['src/a/Util.java', '.java', 0], ['test/SvcTest.java', '.java', 1]],
    symbols: [
      [10, 0, 'handle', 'method', 1, 20, 'handle()'],
      [11, 0, 'validate', 'method', 22, 30, 'validate()'],
      [12, 1, 'get', 'method', 1, 3, 'get()'],
      [13, 1, 'get', 'method', 5, 7, 'get()'],
      [14, 2, 'testHandle', 'test', 1, 9, 'testHandle()']
    ],
    // handle->validate (heuristic, unique name), handle->get (heuristic, ambiguous name),
    // testHandle->handle (lsp), validate->validate (self), duplicate handle->validate
    edges: [0, 1, 0, 0, 2, 0, 4, 0, 1, 1, 1, 0, 0, 1, 0]
  });
}

test('buildModel scores links: lsp is full strength, ambiguous names are discounted', () => {
  const m = core.buildModel(small());
  const strength = (src, dst) => {
    for (let e = 0; e < m.edgeCount; e++) if (m.eSrc[e] === src && m.eDst[e] === dst) return m.eStrength[e];
    return null;
  };
  assert.equal(strength(4, 0), 1);
  assert.ok(Math.abs(strength(0, 1) - core.HEURISTIC_BASE) < 1e-6);
  // `get` exists twice, so a name-matched link to it is worth 0.75 / sqrt(2)
  assert.ok(Math.abs(strength(0, 2) - core.HEURISTIC_BASE / Math.SQRT2) < 1e-6);
});

test('buildModel drops self-calls and de-duplicates repeated links', () => {
  const m = core.buildModel(small());
  assert.equal(m.edgeCount, 3);
});

test('buildModel adjacency lists callers and callees', () => {
  const m = core.buildModel(small());
  const callees = Array.from(m.outEdges.slice(m.outOff[0], m.outOff[1])).map((e) => m.eDst[e]).sort();
  assert.deepEqual(callees, [1, 2]);
  const callers = Array.from(m.inEdges.slice(m.inOff[0], m.inOff[1])).map((e) => m.eSrc[e]);
  assert.deepEqual(callers, [4]);
  assert.ok(m.fanIn[1] > 0 && m.fanIn[4] === 0);
});

test('squarify fills the rectangle in proportion to weight', () => {
  const rect = { x: 0, z: 0, w: 30, d: 20 };
  const items = [{ weight: 6 }, { weight: 3 }, { weight: 2 }, { weight: 1 }];
  const placed = core.squarify(items, rect);
  assert.equal(placed.length, 4);
  const total = placed.reduce((a, p) => a + p.w * p.d, 0);
  assert.ok(Math.abs(total - 600) < 1e-6);
  for (const p of placed) {
    assert.ok(Math.abs((p.w * p.d) / 600 - p.item.weight / 12) < 1e-9);
    assert.ok(p.x >= -1e-9 && p.z >= -1e-9 && p.x + p.w <= 30 + 1e-9 && p.z + p.d <= 20 + 1e-9);
  }
});

// A synthetic repo big enough to exercise nesting: 40 dirs x 5 files x 12 symbols.
function bigSnap() {
  const files = [];
  const symbols = [];
  let id = 1;
  for (let d = 0; d < 40; d++) {
    for (let f = 0; f < 5; f++) {
      const fi = files.length;
      files.push([`src/pkg${d % 7}/mod${d}/File${f}.java`, '.java', 0]);
      for (let s = 0; s < 12; s++) symbols.push([id++, fi, `sym${d}_${f}_${s}`, 'method', s * 10 + 1, s * 10 + 8, '']);
    }
  }
  return snap({ files, symbols });
}

test('layoutCity places every symbol, inside the city, without overlapping blocks', () => {
  const m = core.buildModel(bigSnap());
  const L = core.layoutCity(m);
  assert.ok(L.width > 0 && L.depth > 0);
  const rects = [];
  for (let i = 0; i < m.n; i++) {
    const half = L.pos.size[i] / 2;
    assert.ok(L.pos.size[i] > 0, `symbol ${i} has no footprint`);
    assert.ok(Math.abs(L.pos.x[i]) <= L.width / 2 + 1e-6 && Math.abs(L.pos.z[i]) <= L.depth / 2 + 1e-6);
    rects.push([L.pos.x[i] - half, L.pos.z[i] - half, L.pos.x[i] + half, L.pos.z[i] + half]);
  }
  // sweep along x to find any overlapping pair
  const order = rects.map((_, i) => i).sort((a, b) => rects[a][0] - rects[b][0]);
  for (let a = 0; a < order.length; a++) {
    for (let b = a + 1; b < order.length; b++) {
      const A = rects[order[a]];
      const B = rects[order[b]];
      if (B[0] >= A[2] - 1e-9) break;
      const overlap = B[1] < A[3] - 1e-9 && A[1] < B[3] - 1e-9;
      assert.equal(overlap, false, `blocks ${order[a]} and ${order[b]} overlap`);
    }
  }
});

test('layoutCity keeps each symbol on its own file plot, and plots do not overlap', () => {
  const m = core.buildModel(bigSnap());
  const L = core.layoutCity(m);
  const plotOf = new Map(L.plots.map((p) => [p.fileIdx, p]));
  for (let i = 0; i < m.n; i++) {
    const p = plotOf.get(m.fileOf[i]);
    assert.ok(L.pos.x[i] >= p.x - 1e-6 && L.pos.x[i] <= p.x + p.w + 1e-6);
    assert.ok(L.pos.z[i] >= p.z - 1e-6 && L.pos.z[i] <= p.z + p.d + 1e-6);
  }
  for (let a = 0; a < L.plots.length; a++) {
    for (let b = a + 1; b < L.plots.length; b++) {
      const A = L.plots[a];
      const B = L.plots[b];
      const overlap = A.x < B.x + B.w - 1e-9 && B.x < A.x + A.w - 1e-9 && A.z < B.z + B.d - 1e-9 && B.z < A.z + A.d - 1e-9;
      assert.equal(overlap, false, `plots ${a} and ${b} overlap`);
    }
  }
});

test('layoutCity groups a directory chain into one district and handles an empty repo', () => {
  const m = core.buildModel(bigSnap());
  const L = core.layoutCity(m);
  assert.ok(L.districts.some((d) => d.path.includes('src/pkg')), 'expected a collapsed src/pkgN district');
  const empty = core.layoutCity(core.buildModel(snap({ files: [], symbols: [] })));
  assert.deepEqual([empty.plots.length, empty.width], [0, 0]);
});

test('metric reflects the chosen height mode', () => {
  const m = core.buildModel(small());
  assert.equal(core.metric(m, 'lines')[0], 20);
  assert.ok(core.metric(m, 'callers')[1] > 0);
  assert.ok(core.metric(m, 'callees')[0] > 0);
});

test('search ranks exact, then prefix, then word-start, then substring, then path', () => {
  const m = core.buildModel(snap({
    files: [['src/billing/Invoice.java', '', 0], ['src/other/Thing.java', '', 0]],
    symbols: [
      [1, 0, 'getInvoiceTotal', 'method', 1, 2, ''],
      [2, 1, 'invoice', 'function', 1, 2, ''],
      [3, 1, 'invoiceNumber', 'function', 3, 4, ''],
      [4, 1, 'reinvoiced', 'function', 5, 6, ''],
      [5, 0, 'unrelated', 'method', 3, 4, '']
    ]
  }));
  const names = core.search(m, 'invoice', 10).map((i) => m.names[i]);
  assert.deepEqual(names, ['invoice', 'invoiceNumber', 'getInvoiceTotal', 'reinvoiced', 'unrelated']);
});

test('search requires every word to match, and returns nothing for a blank query', () => {
  const m = core.buildModel(small());
  assert.deepEqual(core.search(m, '', 10), []);
  assert.deepEqual(core.search(m, 'handle zzz', 10), []);
  // a word may match the path instead of the name: both files here contain "svc"
  assert.deepEqual(core.search(m, 'handle svc', 10).map((i) => m.names[i]), ['handle', 'testHandle']);
  assert.deepEqual(core.search(m, 'handle util', 10), []);
});

test('neighborhood separates callers from callees and respects strength and hops', () => {
  const m = core.buildModel(small());
  const around = core.neighborhood(m, 0, 2, 0, 50);
  assert.deepEqual(around.callees.map((l) => l.node).sort(), [1, 2]);
  assert.deepEqual(around.callers.map((l) => l.node), [4]);
  assert.ok(around.callees.every((l) => l.from === 0 && l.to === l.node));
  assert.ok(around.callers.every((l) => l.to === 0 && l.from === l.node));

  const strict = core.neighborhood(m, 0, 1, 0.74, 50);
  assert.deepEqual(strict.callees.map((l) => l.node), [1]); // the ambiguous `get` link is below 0.74
});

test('neighborhood walks multiple hops without revisiting', () => {
  const chain = core.buildModel(snap({
    files: [['a.js', '', 0]],
    symbols: [[1, 0, 'a', 'function', 1, 1, ''], [2, 0, 'b', 'function', 2, 2, ''], [3, 0, 'c', 'function', 3, 3, '']],
    edges: [0, 1, 1, 1, 2, 1, 2, 0, 1]
  }));
  const one = core.neighborhood(chain, 0, 1, 0, 10).callees.map((l) => l.node);
  const two = core.neighborhood(chain, 0, 3, 0, 10).callees.map((l) => [l.node, l.hop]);
  assert.deepEqual(one, [1]);
  assert.deepEqual(two, [[1, 1], [2, 2]]);
});

test('strongestLinks only returns cross-file links, strongest first', () => {
  const m = core.buildModel(small());
  const picked = core.strongestLinks(m, 10, 0);
  assert.ok(picked.every((e) => m.fileOf[m.eSrc[e]] !== m.fileOf[m.eDst[e]]));
  assert.equal(m.eStrength[picked[0]], 1);
});

test('landmarks are ranked by weighted fan-in and skip test files', () => {
  const m = core.buildModel(small());
  const top = core.landmarks(m, 5).map((i) => m.names[i]);
  assert.ok(!top.includes('testHandle'));
  assert.equal(top[0], 'handle');
});

test('diffVersions finds added and removed symbols by file, kind and name', () => {
  const prev = core.buildModel(snap({
    files: [['a.js', '', 0]],
    symbols: [[1, 0, 'keep', 'function', 1, 5, ''], [2, 0, 'gone', 'function', 6, 9, ''], [3, 0, 'dup', 'function', 10, 12, '']]
  }));
  const cur = core.buildModel(snap({
    files: [['a.js', '', 0]],
    // `keep` moved down (different lines) - still the same symbol
    symbols: [[1, 0, 'keep', 'function', 20, 25, ''], [2, 0, 'fresh', 'function', 1, 4, ''], [3, 0, 'dup', 'function', 30, 32, ''], [4, 0, 'dup', 'function', 40, 42, '']]
  }));
  const d = core.diffVersions(cur, prev);
  assert.deepEqual(Array.from(d.added), [0, 1, 0, 1]);
  assert.equal(d.addedCount, 2);
  assert.deepEqual(d.removed, [{ name: 'gone', kind: 'function', path: 'a.js' }]);
});

test('a large repo lays out in well under a second', () => {
  const files = [];
  const symbols = [];
  let id = 1;
  for (let f = 0; f < 1200; f++) {
    const fi = files.length;
    files.push([`src/p${f % 40}/q${f % 13}/F${f}.ts`, '.ts', 0]);
    for (let s = 0; s < 25; s++) symbols.push([id++, fi, `s${f}_${s}`, 'method', s, s + 3, '']);
  }
  const t = Date.now();
  const L = core.layoutCity(core.buildModel(snap({ files, symbols })));
  assert.equal(L.plots.length, 1200);
  assert.ok(Date.now() - t < 1500, `layout took ${Date.now() - t}ms`);
});

function classSnap() {
  return snap({
    files: [['src/Svc.java', '.java', 0], ['src/Client.java', '.java', 0]],
    symbols: [
      [1, 0, 'Svc', 'class', 1, 40, ''],
      [2, 0, 'load', 'method', 5, 15, ''],
      [3, 0, 'save', 'method', 20, 30, ''],
      [4, 0, 'orphanInSameFile', 'method', 50, 60, ''],
      [5, 1, 'run', 'method', 1, 9, ''],
      [6, 1, 'helper', 'method', 10, 19, '']
    ],
    // run -> load, run -> save, load -> save (internal), save -> helper
    edges: [4, 1, 1, 4, 2, 1, 1, 2, 1, 2, 5, 1]
  });
}

test('members finds the methods inside a class by line range, and nothing for non-classes', () => {
  const m = core.buildModel(classSnap());
  assert.deepEqual(core.members(m, 0).map((i) => m.names[i]), ['load', 'save']);
  assert.deepEqual(core.members(m, 1), []);
});

test('a class is walked from its methods, so it has callers and calls of its own', () => {
  const m = core.buildModel(classSnap());
  assert.equal(m.rawIn[0] + m.rawOut[0], 0); // nothing is recorded against the class itself
  const around = core.neighborhood(m, 0, 1, 0, 50);
  // `run` calls two of its methods but is listed once, as one caller
  assert.deepEqual(around.callers.map((l) => m.names[l.node]), ['run']);
  assert.deepEqual(around.callees.map((l) => m.names[l.node]), ['helper']);
  assert.ok(['load', 'save'].includes(m.names[around.callers[0].via]));
  // links between the class's own methods are not "callers" of the class
  assert.ok(around.callers.every((l) => !around.members.includes(l.node)));
});

test('rolledCounts counts distinct outside callers and callees, not internal links', () => {
  const m = core.buildModel(classSnap());
  assert.deepEqual(core.rolledCounts(m, 0), { callers: 1, calls: 1 });
  assert.deepEqual(core.rolledCounts(m, 1), { callers: m.rawIn[1], calls: m.rawOut[1] });
});
