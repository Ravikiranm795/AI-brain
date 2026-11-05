/*
 * Pure logic behind the 3D viewer: no DOM, no WebGL. Loaded as a classic
 * <script> by the page (window.BrainCore) and require()d by the tests.
 *
 * A "snapshot" is the payload written by src/vizData.js:
 *   { files: [[path, ext, isTest]], symbols: [[id, fileIdx, name, kind,
 *     startLine, endLine, signature]], edges: [src, dst, res, ...] }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BrainCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Same trust model as graphStore's _scoreEdge: an LSP-resolved edge is a
  // real go-to-definition; a heuristic edge is a *name* match across the whole
  // repo, so it is worth less the more symbols share that name.
  var HEURISTIC_BASE = 0.75;

  function normalizePath(p) {
    return String(p).replace(/\\/g, '/');
  }

  /* ------------------------------------------------------------------ model */

  function buildModel(snap) {
    var n = snap.symbols.length;
    var ids = new Int32Array(n);
    var fileOf = new Int32Array(n);
    var startLine = new Int32Array(n);
    var endLine = new Int32Array(n);
    var names = new Array(n);
    var kinds = new Array(n);
    var sigs = new Array(n);
    var nameCount = new Map();

    for (var i = 0; i < n; i++) {
      var s = snap.symbols[i];
      ids[i] = s[0];
      fileOf[i] = s[1];
      names[i] = s[2];
      kinds[i] = s[3];
      startLine[i] = s[4];
      endLine[i] = s[5];
      sigs[i] = s[6] || '';
      nameCount.set(s[2], (nameCount.get(s[2]) || 0) + 1);
    }

    var paths = snap.files.map(function (f) { return normalizePath(f[0]); });
    var isTestFile = snap.files.map(function (f) { return !!f[2]; });

    // Edges, de-duplicated per (src, dst) keeping the strongest, self-calls dropped.
    var best = new Map();
    var raw = snap.edges;
    for (var e = 0; e < raw.length; e += 3) {
      var src = raw[e];
      var dst = raw[e + 1];
      if (src === dst) continue;
      var lsp = raw[e + 2] === 1;
      var strength = lsp ? 1 : HEURISTIC_BASE / Math.sqrt(Math.max(1, nameCount.get(names[dst]) || 1));
      var key = src * n + dst;
      var prev = best.get(key);
      if (prev === undefined || strength > prev.strength) best.set(key, { src: src, dst: dst, strength: strength, lsp: lsp });
    }

    var m = best.size;
    var eSrc = new Int32Array(m);
    var eDst = new Int32Array(m);
    var eStrength = new Float32Array(m);
    var eLsp = new Uint8Array(m);
    var k = 0;
    best.forEach(function (v) {
      eSrc[k] = v.src;
      eDst[k] = v.dst;
      eStrength[k] = v.strength;
      eLsp[k] = v.lsp ? 1 : 0;
      k++;
    });

    var out = csr(n, eSrc, m);
    var inn = csr(n, eDst, m);
    var fanIn = new Float32Array(n);
    var fanOut = new Float32Array(n);
    var rawIn = new Int32Array(n);
    var rawOut = new Int32Array(n);
    for (var j = 0; j < m; j++) {
      fanOut[eSrc[j]] += eStrength[j];
      fanIn[eDst[j]] += eStrength[j];
      rawOut[eSrc[j]]++;
      rawIn[eDst[j]]++;
    }

    var lowerNames = names.map(function (x) { return x.toLowerCase(); });
    var lowerPaths = paths.map(function (x) { return x.toLowerCase(); });

    return {
      n: n, ids: ids, fileOf: fileOf, startLine: startLine, endLine: endLine,
      names: names, kinds: kinds, sigs: sigs, paths: paths, isTestFile: isTestFile,
      lowerNames: lowerNames, lowerPaths: lowerPaths,
      edgeCount: m, eSrc: eSrc, eDst: eDst, eStrength: eStrength, eLsp: eLsp,
      outOff: out.off, outEdges: out.list, inOff: inn.off, inEdges: inn.list,
      fanIn: fanIn, fanOut: fanOut, rawIn: rawIn, rawOut: rawOut,
      indexById: indexById(ids)
    };
  }

  function indexById(ids) {
    var map = new Map();
    for (var i = 0; i < ids.length; i++) map.set(ids[i], i);
    return map;
  }

  /** Compressed adjacency: edge indexes grouped by the node in `keyOf`. */
  function csr(n, keyOf, m) {
    var off = new Int32Array(n + 1);
    for (var i = 0; i < m; i++) off[keyOf[i] + 1]++;
    for (var v = 0; v < n; v++) off[v + 1] += off[v];
    var cursor = off.slice(0, n);
    var list = new Int32Array(m);
    for (var e = 0; e < m; e++) list[cursor[keyOf[e]]++] = e;
    return { off: off, list: list };
  }

  /* --------------------------------------------------------------- treemap */

  // Standard squarified treemap (Bruls et al.): lays `items` (each with a
  // .weight) into `rect`, keeping aspect ratios close to 1.
  function squarify(items, rect) {
    var total = items.reduce(function (a, b) { return a + b.weight; }, 0);
    var placed = [];
    if (!items.length || total <= 0 || rect.w <= 0 || rect.d <= 0) return placed;

    var sorted = items.slice().sort(function (a, b) { return b.weight - a.weight; });
    var scale = (rect.w * rect.d) / total;
    var x = rect.x, z = rect.z, w = rect.w, d = rect.d;
    var row = [];

    function worst(r, side) {
      var sum = 0, max = 0, min = Infinity;
      for (var i = 0; i < r.length; i++) {
        var a = r[i].weight * scale;
        sum += a;
        if (a > max) max = a;
        if (a < min) min = a;
      }
      var s2 = side * side;
      return Math.max((s2 * max) / (sum * sum), (sum * sum) / (s2 * min));
    }

    function flush() {
      if (!row.length) return;
      var sum = row.reduce(function (a, b) { return a + b.weight * scale; }, 0);
      if (w >= d) {
        // lay the row as a column on the left edge
        var colW = sum / d;
        var cz = z;
        row.forEach(function (it) {
          var h = (it.weight * scale) / colW;
          placed.push({ item: it, x: x, z: cz, w: colW, d: h });
          cz += h;
        });
        x += colW;
        w -= colW;
      } else {
        var rowD = sum / w;
        var cx = x;
        row.forEach(function (it) {
          var ww = (it.weight * scale) / rowD;
          placed.push({ item: it, x: cx, z: z, w: ww, d: rowD });
          cx += ww;
        });
        z += rowD;
        d -= rowD;
      }
      row = [];
    }

    sorted.forEach(function (it) {
      var side = Math.min(w, d);
      if (!row.length || worst(row.concat([it]), side) <= worst(row, side)) {
        row.push(it);
      } else {
        flush();
        row.push(it);
      }
    });
    flush();
    return placed;
  }

  /* ---------------------------------------------------------------- layout */

  /**
   * Lays the repo out as a model city: directories are districts, files are
   * plots, symbols are blocks on their file's plot. Plot area is proportional
   * to symbol count, so blocks stay roughly the same footprint everywhere
   * and a big file is visibly a big plot.
   *
   * Returns world-space (x, z) centers and a footprint for every symbol, plus
   * the plot and district rectangles for the ground.
   */
  function layoutCity(model, opts) {
    opts = opts || {};
    var cell = opts.cell || 1;

    var bySymbolsInFile = new Map();
    for (var i = 0; i < model.n; i++) {
      var f = model.fileOf[i];
      if (!bySymbolsInFile.has(f)) bySymbolsInFile.set(f, []);
      bySymbolsInFile.get(f).push(i);
    }
    bySymbolsInFile.forEach(function (list) {
      list.sort(function (a, b) { return model.startLine[a] - model.startLine[b] || a - b; });
    });

    // Directory tree
    var rootNode = { name: '', children: new Map(), files: [], weight: 0 };
    bySymbolsInFile.forEach(function (list, fileIdx) {
      var parts = model.paths[fileIdx].split('/').filter(Boolean);
      var fileName = parts.pop() || model.paths[fileIdx];
      var node = rootNode;
      parts.forEach(function (seg) {
        if (!node.children.has(seg)) node.children.set(seg, { name: seg, children: new Map(), files: [], weight: 0 });
        node = node.children.get(seg);
      });
      node.files.push({ fileIdx: fileIdx, name: fileName, weight: list.length, symbols: list });
    });

    // Collapse a/b/c chains with a single directory child and no files of
    // their own, so deep package paths don't eat the plan with nested padding.
    function collapse(node) {
      node.children.forEach(function (child, key) {
        var c = child;
        while (c.children.size === 1 && c.files.length === 0) {
          var only = c.children.values().next().value;
          only.name = c.name + '/' + only.name;
          c = only;
        }
        collapse(c);
        node.children.set(key, c);
      });
    }
    collapse(rootNode);

    function weigh(node) {
      var w = 0;
      node.files.forEach(function (f) { w += f.weight; });
      node.children.forEach(function (c) { w += weigh(c); });
      node.weight = w;
      return w;
    }
    var total = weigh(rootNode);

    var pos = {
      x: new Float32Array(model.n),
      z: new Float32Array(model.n),
      size: new Float32Array(model.n)
    };
    var plots = [];
    var districts = [];
    if (!total) return { pos: pos, plots: plots, districts: districts, width: 0, depth: 0 };

    var area = total * cell * cell * 1.7;
    var W = Math.sqrt(area * 1.5);
    var D = area / W;
    var pad = cell * 0.45;

    function placeFile(file, rect) {
      var gap = Math.min(pad * 0.5, rect.w * 0.12, rect.d * 0.12);
      var x0 = rect.x + gap, z0 = rect.z + gap;
      var w = Math.max(rect.w - gap * 2, cell * 0.2);
      var d = Math.max(rect.d - gap * 2, cell * 0.2);
      var count = file.symbols.length;
      var cols = Math.max(1, Math.min(count, Math.round(Math.sqrt((count * w) / d))));
      var rows = Math.ceil(count / cols);
      var cs = Math.min(w / cols, d / rows);
      // center the grid inside the plot
      var gx = x0 + (w - cs * cols) / 2;
      var gz = z0 + (d - cs * rows) / 2;
      file.symbols.forEach(function (sym, k) {
        var c = k % cols, r = Math.floor(k / cols);
        pos.x[sym] = gx + (c + 0.5) * cs;
        pos.z[sym] = gz + (r + 0.5) * cs;
        pos.size[sym] = cs * 0.74;
      });
      plots.push({ fileIdx: file.fileIdx, x: x0, z: z0, w: w, d: d });
    }

    function placeNode(node, rect, depth, pathSoFar) {
      var inner = {
        x: rect.x + pad, z: rect.z + pad,
        w: Math.max(rect.w - pad * 2, 0.01), d: Math.max(rect.d - pad * 2, 0.01)
      };
      var items = [];
      node.files.forEach(function (f) { items.push({ kind: 'file', weight: f.weight, file: f }); });
      node.children.forEach(function (c) { items.push({ kind: 'dir', weight: c.weight, dir: c }); });
      squarify(items, inner).forEach(function (cell2) {
        var it = cell2.item;
        var r = { x: cell2.x, z: cell2.z, w: cell2.w, d: cell2.d };
        if (it.kind === 'file') {
          placeFile(it.file, r);
        } else {
          var p = pathSoFar ? pathSoFar + '/' + it.dir.name : it.dir.name;
          districts.push({ path: p, name: it.dir.name, depth: depth + 1, x: r.x, z: r.z, w: r.w, d: r.d, weight: it.dir.weight });
          placeNode(it.dir, r, depth + 1, p);
        }
      });
    }

    // Origin at the center of the city.
    placeNode(rootNode, { x: -W / 2, z: -D / 2, w: W, d: D }, 0, '');
    return { pos: pos, plots: plots, districts: districts, width: W, depth: D };
  }

  /* ----------------------------------------------------------- measurement */

  /** Raw per-symbol quantity the block height encodes. */
  function metric(model, mode) {
    var out = new Float32Array(model.n);
    for (var i = 0; i < model.n; i++) {
      if (mode === 'callers') out[i] = model.fanIn[i];
      else if (mode === 'callees') out[i] = model.fanOut[i];
      else out[i] = Math.max(1, model.endLine[i] - model.startLine[i] + 1);
    }
    return out;
  }

  function percentile(arr, p) {
    if (!arr.length) return 0;
    var copy = Array.prototype.slice.call(arr).sort(function (a, b) { return a - b; });
    return copy[Math.min(copy.length - 1, Math.floor(p * (copy.length - 1)))];
  }

  /* ---------------------------------------------------------------- search */

  /**
   * Ranks symbols for a typed query. Every whitespace-separated word must
   * match the name or the path. Exact > prefix > camelCase-word prefix >
   * substring in name > substring in path; popular symbols break ties.
   */
  function search(model, query, limit) {
    limit = limit || 30;
    var words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    var scored = [];
    for (var i = 0; i < model.n; i++) {
      var name = model.lowerNames[i];
      var path = model.lowerPaths[model.fileOf[i]];
      var total = 0;
      var ok = true;
      for (var w = 0; w < words.length; w++) {
        var q = words[w];
        var s = 0;
        if (name === q) s = 100;
        else if (name.indexOf(q) === 0) s = 80;
        else if (wordStart(model.names[i], q)) s = 60;
        else if (name.indexOf(q) !== -1) s = 40;
        else if (path.indexOf(q) !== -1) s = 15;
        if (!s) { ok = false; break; }
        total += s;
      }
      if (!ok) continue;
      scored.push({ index: i, score: total + Math.log(1 + model.fanIn[i]) });
    }
    scored.sort(function (a, b) { return b.score - a.score || model.names[a.index].length - model.names[b.index].length; });
    return scored.slice(0, limit).map(function (s) { return s.index; });
  }

  // True when `q` starts one of the camelCase / snake_case words in `name`.
  function wordStart(name, q) {
    var spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase();
    var parts = spaced.split(/[^a-z0-9]+/);
    for (var i = 0; i < parts.length; i++) if (parts[i].indexOf(q) === 0) return true;
    return false;
  }

  /* ---------------------------------------------------------- neighborhood */

  /**
   * Callees (what `idx` reaches) and callers (what reaches `idx`), out to
   * `hops` steps, following only links at least `minStrength` strong.
   * Strongest first within each hop; at most `cap` links per direction.
   */
  function neighborhood(model, idx, hops, minStrength, cap) {
    cap = cap || 120;
    // Calls are recorded against methods, never the class that holds them, so a
    // class is walked from all of its methods too (the same rollup `brain check` does).
    var inside = members(model, idx);
    var seeds = [idx].concat(inside);
    return {
      members: inside,
      callees: walk(model, seeds, hops, minStrength, cap, true),
      callers: walk(model, seeds, hops, minStrength, cap, false)
    };
  }

  function byFile(model) {
    if (!model._byFile) {
      var map = new Map();
      for (var i = 0; i < model.n; i++) {
        var f = model.fileOf[i];
        if (!map.has(f)) map.set(f, []);
        map.get(f).push(i);
      }
      model._byFile = map;
    }
    return model._byFile;
  }

  /** The methods, functions and hooks declared inside a class, by line containment in its file. */
  function members(model, idx) {
    if (model.kinds[idx] !== 'class') return [];
    var s = model.startLine[idx], e = model.endLine[idx];
    return (byFile(model).get(model.fileOf[idx]) || []).filter(function (j) {
      var k = model.kinds[j];
      return j !== idx && model.startLine[j] >= s && model.endLine[j] <= e && (k === 'method' || k === 'function' || k === 'hook');
    });
  }

  /** Callers and calls counted across a class's methods too, ignoring links that stay inside the class. */
  function rolledCounts(model, idx) {
    var seeds = [idx].concat(members(model, idx));
    if (seeds.length === 1) return { callers: model.rawIn[idx], calls: model.rawOut[idx] };
    var inSet = new Set(seeds), callers = new Set(), calls = new Set();
    seeds.forEach(function (s) {
      for (var k = model.inOff[s]; k < model.inOff[s + 1]; k++) { var a = model.eSrc[model.inEdges[k]]; if (!inSet.has(a)) callers.add(a); }
      for (var q = model.outOff[s]; q < model.outOff[s + 1]; q++) { var b = model.eDst[model.outEdges[q]]; if (!inSet.has(b)) calls.add(b); }
    });
    return { callers: callers.size, calls: calls.size };
  }

  function walk(model, seeds, hops, minStrength, cap, forward) {
    var off = forward ? model.outOff : model.inOff;
    var list = forward ? model.outEdges : model.inEdges;
    var seen = new Set(seeds);
    var frontier = seeds.slice();
    var links = [];
    for (var h = 1; h <= hops && frontier.length; h++) {
      var level = [];
      for (var f = 0; f < frontier.length; f++) {
        var node = frontier[f];
        for (var k = off[node]; k < off[node + 1]; k++) {
          var e = list[k];
          if (model.eStrength[e] < minStrength) continue;
          var other = forward ? model.eDst[e] : model.eSrc[e];
          if (seen.has(other)) continue;
          level.push({ edge: e, from: forward ? node : other, to: forward ? other : node, node: other, strength: model.eStrength[e], hop: h, via: h === 1 ? node : -1 });
        }
      }
      level.sort(function (a, b) { return b.strength - a.strength; });
      var next = [];
      for (var i = 0; i < level.length && links.length < cap; i++) {
        if (seen.has(level[i].node)) continue;
        seen.add(level[i].node);
        links.push(level[i]);
        next.push(level[i].node);
      }
      frontier = next;
    }
    return links;
  }

  /** Strongest cross-file links in the whole repo, for the optional overview arcs. */
  function strongestLinks(model, count, minStrength) {
    var picked = [];
    for (var e = 0; e < model.edgeCount; e++) {
      if (model.eStrength[e] < minStrength) continue;
      if (model.fileOf[model.eSrc[e]] === model.fileOf[model.eDst[e]]) continue;
      picked.push(e);
    }
    picked.sort(function (a, b) {
      return model.eStrength[b] - model.eStrength[a] || (model.fanIn[model.eDst[b]] - model.fanIn[model.eDst[a]]);
    });
    return picked.slice(0, count);
  }

  /* ------------------------------------------------------------- landmarks */

  /**
   * Most-depended-on symbols, with ambiguous names already discounted. Symbols
   * that share a name are listed once: a name-matched call is attributed to
   * every symbol of that name, so same-named siblings always score identically
   * and would otherwise fill the list with copies of one finding.
   */
  function landmarks(model, count) {
    var order = [];
    for (var i = 0; i < model.n; i++) {
      if (model.fanIn[i] > 0 && !model.isTestFile[model.fileOf[i]]) order.push(i);
    }
    order.sort(function (a, b) { return model.fanIn[b] - model.fanIn[a]; });
    var seen = new Set(), out = [];
    for (var k = 0; k < order.length && out.length < count; k++) {
      var name = model.names[order[k]];
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(order[k]);
    }
    return out;
  }

  /* ----------------------------------------------------------- version diff */

  function symbolKey(model, i, counter) {
    var base = model.paths[model.fileOf[i]] + '\u0000' + model.kinds[i] + '\u0000' + model.names[i];
    var c = (counter.get(base) || 0) + 1;
    counter.set(base, c);
    return base + '\u0000' + c;
  }

  /**
   * What changed between two builds, matched on (file, kind, name) - line
   * numbers move on any edit, so they can't identify a symbol. Overloads are
   * told apart by order of appearance.
   */
  function diffVersions(current, previous) {
    var prevKeys = new Set();
    var counter = new Map();
    for (var p = 0; p < previous.n; p++) prevKeys.add(symbolKey(previous, p, counter));

    var added = new Uint8Array(current.n);
    var addedCount = 0;
    var currentKeys = new Set();
    counter = new Map();
    for (var i = 0; i < current.n; i++) {
      var key = symbolKey(current, i, counter);
      currentKeys.add(key);
      if (!prevKeys.has(key)) {
        added[i] = 1;
        addedCount++;
      }
    }

    var removed = [];
    counter = new Map();
    for (var r = 0; r < previous.n; r++) {
      var rk = symbolKey(previous, r, counter);
      if (!currentKeys.has(rk)) removed.push({ name: previous.names[r], kind: previous.kinds[r], path: previous.paths[previous.fileOf[r]] });
    }
    return { added: added, addedCount: addedCount, removed: removed, removedCount: removed.length };
  }

  return {
    HEURISTIC_BASE: HEURISTIC_BASE,
    buildModel: buildModel,
    squarify: squarify,
    layoutCity: layoutCity,
    metric: metric,
    percentile: percentile,
    search: search,
    neighborhood: neighborhood,
    members: members,
    rolledCounts: rolledCounts,
    strongestLinks: strongestLinks,
    landmarks: landmarks,
    diffVersions: diffVersions
  };
});
