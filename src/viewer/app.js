/*
 * Brain model: the interactive 3D viewer. Layout, scoring, search and version
 * diffing live in core.js (unit-tested); this file is the DOM and WebGL around it.
 */
(function () {
  'use strict';

  var Core = window.BrainCore;
  var THREE = window.THREE;

  /* ------------------------------------------------------------ helpers */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(n) { return Number(n).toLocaleString(); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return 'unknown date';
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  function motionOk() { return !reduceMotion.matches; }
  function store(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
    } catch (_) { /* storage unavailable - the viewer works without it */ }
    return null;
  }

  var KINDS = ['class', 'method', 'function', 'test', 'suite', 'hook', 'file'];
  var KIND_LABEL = { class: 'Classes', method: 'Methods', function: 'Functions', test: 'Tests', suite: 'Test suites', hook: 'Hooks', file: 'Whole files', other: 'Other' };

  /* ------------------------------------------------------------ data loading */

  // Snapshot files call BRAIN_VIZ.register(...) when their <script> runs.
  var BRAIN_VIZ = window.BRAIN_VIZ = {
    snaps: {}, waiting: {}, order: [],
    register: function (snap) {
      var key = snap.repoId + '/' + snap.versionId;
      this.snaps[key] = snap;
      this.order = this.order.filter(function (k) { return k !== key; });
      this.order.push(key);
      while (this.order.length > 3) delete this.snaps[this.order.shift()];
      (this.waiting[key] || []).forEach(function (w) { w.resolve(snap); });
      delete this.waiting[key];
    }
  };

  function loadSnapshot(repoId, versionId) {
    var key = repoId + '/' + versionId;
    if (BRAIN_VIZ.snaps[key]) return Promise.resolve(BRAIN_VIZ.snaps[key]);
    return new Promise(function (resolve, reject) {
      (BRAIN_VIZ.waiting[key] = BRAIN_VIZ.waiting[key] || []).push({ resolve: resolve });
      var s = document.createElement('script');
      s.src = 'repos/' + encodeURIComponent(repoId) + '/' + encodeURIComponent(versionId) + '.js';
      s.onerror = function () { s.remove(); reject(new Error('Could not load ' + s.src)); };
      document.head.appendChild(s);
      setTimeout(function () { if (!BRAIN_VIZ.snaps[key]) reject(new Error('Timed out loading this build')); }, 60000);
    });
  }

  /* ------------------------------------------------------------ state */

  var S = {
    index: window.BRAIN_VIZ_INDEX || { repos: [] },
    repo: null, versionId: null,
    snap: null, model: null, layout: null,
    heightMode: 'lines', minStrength: 0.2, hops: 1, showTop: false, topCount: 200,
    kindOn: {}, visible: null, heights: null,
    selected: -1, hover: -1, history: [],
    compare: false, other: null, diff: null,
    topDown: false, theme: 'light'
  };

  var R = {};          // renderer, scene, camera and the objects in it
  var cam = {};        // camera rig
  var dirty = true, rafId = 0, lastT = 0, intro = null, drawOn = null;

  /* ------------------------------------------------------------ renderer */

  function initRenderer() {
    var canvas = $('stage');
    try {
      R.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
    } catch (e) {
      showOverlay({
        title: 'This browser cannot show the 3D model',
        text: 'WebGL is turned off or unavailable. Try another browser, or switch on hardware acceleration in this browser’s settings.',
        static: true
      });
      return false;
    }
    R.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    R.scene = new THREE.Scene();
    R.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 6000);
    R.hemi = new THREE.HemisphereLight(0xffffff, 0x8a979c, 0.78);
    R.sun = new THREE.DirectionalLight(0xffffff, 0.8);
    R.sun.position.set(-0.55, 1, 0.7);
    R.scene.add(R.hemi, R.sun);
    R.pickTarget = new THREE.WebGLRenderTarget(1, 1);
    R.pickScene = new THREE.Scene();
    R.pixel = new Uint8Array(4);
    R.ray = new THREE.Raycaster();
    R.ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    return true;
  }

  function resize() {
    var w = window.innerWidth, h = window.innerHeight;
    R.renderer.setSize(w, h, false);
    R.camera.aspect = w / h;
    R.camera.updateProjectionMatrix();
    invalidate();
  }

  /* ------------------------------------------------------------ palette */

  function palette() {
    var P = { kind: {}, group: new THREE.Color(css('--ground')) };
    KINDS.forEach(function (k) { P.kind[k] = new THREE.Color(css('--k-' + k)); });
    P.kind.other = new THREE.Color(css('--k-file'));
    P.out = new THREE.Color(css('--out'));
    P.inn = new THREE.Color(css('--in'));
    P.select = new THREE.Color(css('--select'));
    P.neu = new THREE.Color(css('--new'));
    P.plot = new THREE.Color(css('--plot'));
    P.plotEdge = new THREE.Color(css('--plot-edge'));
    P.districtEdge = new THREE.Color(css('--district-edge'));
    P.ink = new THREE.Color(css('--ink'));
    return P;
  }
  var PAL = null;

  function applyTheme(theme) {
    S.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    store('brain-theme', theme);
    PAL = palette();
    if (R.scene) {
      R.scene.background = PAL.group;
      R.scene.fog = fogFor();
      R.hemi.groundColor.set(theme === 'dark' ? 0x2a3a42 : 0x8a979c);
      R.hemi.intensity = theme === 'dark' ? 0.95 : 0.78;
      R.sun.intensity = theme === 'dark' ? 0.7 : 0.8;
      if (S.model) { rebuildGround(); applyColors(); rebuildArcs(); }
      invalidate();
    }
  }

  function fogFor() {
    var w = S.layout ? Math.max(S.layout.width, S.layout.depth) : 200;
    return new THREE.Fog(PAL.group, w * 1.4, w * 4.2);
  }

  /* ------------------------------------------------------------ scene build */

  function disposeObject(o) {
    if (!o) return;
    R.scene.remove(o);
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  }

  function buildScene() {
    var m = S.model, L = S.layout;
    ['blocks', 'plots', 'plotLines', 'districtLines', 'floor', 'arcs', 'ends', 'selBox', 'hoverBox'].forEach(function (k) {
      disposeObject(R[k]); R[k] = null;
    });
    R.pickScene.children.slice().forEach(function (c) { R.pickScene.remove(c); });

    // Blocks: one instanced box for the whole repo.
    var geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    var blocks = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff }), Math.max(1, m.n));
    blocks.frustumCulled = false;
    blocks.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, m.n) * 3), 3);
    blocks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    R.blocks = blocks;
    R.scene.add(blocks);

    // The same instances again, painted as flat ids, for exact picking.
    var pick = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }), Math.max(1, m.n));
    pick.frustumCulled = false;
    pick.instanceMatrix = blocks.instanceMatrix;
    var ids = new Float32Array(Math.max(1, m.n) * 3);
    for (var i = 0; i < m.n; i++) {
      var v = i + 1;
      ids[i * 3] = (v & 255) / 255;
      ids[i * 3 + 1] = ((v >> 8) & 255) / 255;
      ids[i * 3 + 2] = ((v >> 16) & 255) / 255;
    }
    pick.instanceColor = new THREE.InstancedBufferAttribute(ids, 3);
    R.pick = pick;
    R.pickScene.add(pick);

    var box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    var edges = new THREE.EdgesGeometry(box);
    R.selBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: PAL.select }));
    R.selBox.visible = false;
    R.hoverBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: PAL.ink }));
    R.hoverBox.visible = false;
    R.scene.add(R.selBox, R.hoverBox);

    rebuildGround();
    computeHeights();
    computeVisibility();
    writeMatrices(function () { return 0; });
    applyColors();
    buildDistrictLabels();
  }

  function rebuildGround() {
    ['plots', 'plotLines', 'districtLines', 'floor'].forEach(function (k) { disposeObject(R[k]); R[k] = null; });
    var L = S.layout, m = S.model;
    var span = Math.max(L.width, L.depth, 40);

    var floor = new THREE.Mesh(new THREE.PlaneGeometry(span * 12, span * 12), new THREE.MeshBasicMaterial({ color: PAL.group }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.04;
    R.floor = floor;
    R.scene.add(floor);

    var np = L.plots.length;
    var pos = new Float32Array(np * 18), col = new Float32Array(np * 18), lines = new Float32Array(np * 24);
    var tintTest = new THREE.Color(css('--k-test'));
    L.plots.forEach(function (p, i) {
      var c = PAL.plot.clone();
      if (m.isTestFile[p.fileIdx]) c.lerp(tintTest, 0.14);
      var x0 = p.x, x1 = p.x + p.w, z0 = p.z, z1 = p.z + p.d, y = 0.0;
      var quad = [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1];
      for (var k = 0; k < 6; k++) {
        pos[i * 18 + k * 3] = quad[k * 3]; pos[i * 18 + k * 3 + 1] = quad[k * 3 + 1]; pos[i * 18 + k * 3 + 2] = quad[k * 3 + 2];
        col[i * 18 + k * 3] = c.r; col[i * 18 + k * 3 + 1] = c.g; col[i * 18 + k * 3 + 2] = c.b;
      }
      var ly = 0.03, o = i * 24;
      var seg = [x0, ly, z0, x1, ly, z0, x1, ly, z0, x1, ly, z1, x1, ly, z1, x0, ly, z1, x0, ly, z1, x0, ly, z0];
      for (var q = 0; q < 24; q++) lines[o + q] = seg[q];
    });
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    R.plots = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true }));
    R.scene.add(R.plots);

    var lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(lines, 3));
    R.plotLines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: PAL.plotEdge }));
    R.scene.add(R.plotLines);

    // District outlines, drawn twice (one inset) so a folder reads as a heavier boundary than a plot.
    var dl = [];
    L.districts.forEach(function (d) {
      [0, Math.min(0.25, d.w * 0.04, d.d * 0.04)].forEach(function (inset) {
        var x0 = d.x + inset, x1 = d.x + d.w - inset, z0 = d.z + inset, z1 = d.z + d.d - inset, y = 0.05;
        dl.push(x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0);
      });
    });
    var dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(dl), 3));
    R.districtLines = new THREE.LineSegments(dg, new THREE.LineBasicMaterial({ color: PAL.districtEdge }));
    R.scene.add(R.districtLines);
    R.scene.fog = fogFor();
  }

  /* ------------------------------------------------------------ per-block state */

  function computeHeights() {
    var m = S.model;
    var raw = Core.metric(m, S.heightMode);
    var p98 = Math.max(Core.percentile(raw, 0.98), 1e-6);
    var h = new Float32Array(m.n);
    for (var i = 0; i < m.n; i++) {
      var u = Math.min(1.6, Math.sqrt(raw[i] / p98));
      // Whole-file chunks (config, markup) would otherwise tower over the code that matters.
      h[i] = 0.25 + u * (m.kinds[i] === 'file' ? 3.5 : 7);
    }
    S.heights = h;
  }

  function computeVisibility() {
    var m = S.model;
    var vis = new Uint8Array(m.n);
    for (var i = 0; i < m.n; i++) vis[i] = S.kindOn[kindKey(m.kinds[i])] ? 1 : 0;
    S.visible = vis;
  }

  function kindKey(k) { return KINDS.indexOf(k) >= 0 ? k : 'other'; }

  // `rise(i)` is each block's current height fraction (0..1); the intro animates it.
  function writeMatrices(rise) {
    var m = S.model, P = S.layout.pos, arr = R.blocks.instanceMatrix.array;
    for (var i = 0; i < m.n; i++) {
      var o = i * 16;
      var on = S.visible[i];
      var sz = on ? P.size[i] : 0;
      arr[o] = sz; arr[o + 5] = on ? Math.max(0.0001, S.heights[i] * rise(i)) : 0; arr[o + 10] = sz;
      arr[o + 12] = P.x[i]; arr[o + 13] = 0; arr[o + 14] = P.z[i]; arr[o + 15] = 1;
    }
    R.blocks.instanceMatrix.needsUpdate = true;
  }

  var focus = { callees: null, callers: null, members: null };

  function applyColors() {
    var m = S.model, arr = R.blocks.instanceColor.array;
    var sel = S.selected;
    var c = new THREE.Color();
    for (var i = 0; i < m.n; i++) {
      c.copy(PAL.kind[kindKey(m.kinds[i])]);
      var dim = 0;
      if (sel >= 0) {
        if (i === sel) c.copy(PAL.select);
        else if (focus.members && focus.members.has(i)) c.lerp(PAL.select, 0.55);
        else if (focus.callees && focus.callees.has(i)) c.lerp(PAL.out, 0.6);
        else if (focus.callers && focus.callers.has(i)) c.lerp(PAL.inn, 0.6);
        else dim = 0.74;
      } else if (S.compare && S.diff) {
        if (S.diff.added[i]) c.copy(PAL.neu);
        else dim = 0.7;
      }
      if (dim) c.lerp(PAL.group, dim);
      arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
    }
    R.blocks.instanceColor.needsUpdate = true;
    invalidate();
  }

  function blockTop(i) {
    var P = S.layout.pos;
    return new THREE.Vector3(P.x[i], S.heights[i] + 0.15, P.z[i]);
  }

  /* ------------------------------------------------------------ arcs */

  var ARC_SEGS = 24;
  var arcVert = 'attribute vec4 aColor; attribute float aT; varying vec4 vColor; varying float vT;' +
    'void main(){ vColor = aColor; vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  var arcFrag = 'uniform float uProgress; varying vec4 vColor; varying float vT;' +
    'void main(){ if (vT > uProgress) discard; gl_FragColor = vColor; }';

  function currentLinks() {
    var m = S.model, links = [];
    if (S.selected >= 0) {
      var around = Core.neighborhood(m, S.selected, S.hops, S.minStrength, 120);
      around.callees.forEach(function (l) { links.push({ from: l.from, to: l.to, s: l.strength, hop: l.hop, type: 'out' }); });
      around.callers.forEach(function (l) { links.push({ from: l.from, to: l.to, s: l.strength, hop: l.hop, type: 'in' }); });
      focus.members = new Set(around.members);
      focus.callees = new Set(around.callees.map(function (l) { return l.node; }));
      focus.callers = new Set(around.callers.map(function (l) { return l.node; }));
    } else {
      focus.callees = focus.callers = focus.members = null;
      if (S.showTop) {
        Core.strongestLinks(m, S.topCount, Math.max(S.minStrength, 0.3)).forEach(function (e) {
          links.push({ from: m.eSrc[e], to: m.eDst[e], s: m.eStrength[e], hop: 1, type: 'top' });
        });
      }
    }
    return links.filter(function (l) { return S.visible[l.from] && S.visible[l.to]; });
  }

  function rebuildArcs() {
    disposeObject(R.arcs); disposeObject(R.ends);
    R.arcs = R.ends = null;
    var links = currentLinks();
    S.links = links;
    if (!links.length) { invalidate(); return; }

    var n = links.length;
    var pos = new Float32Array(n * ARC_SEGS * 2 * 3);
    var colr = new Float32Array(n * ARC_SEGS * 2 * 4);
    var tt = new Float32Array(n * ARC_SEGS * 2);
    var endPos = new Float32Array(n * 3), endCol = new Float32Array(n * 3);
    var neutral = PAL.ink;
    var a = new THREE.Vector3(), b = new THREE.Vector3(), ctl = new THREE.Vector3(), p = new THREE.Vector3(), q = new THREE.Vector3();

    links.forEach(function (l, li) {
      a.copy(blockTop(l.from)); b.copy(blockTop(l.to));
      var dist = a.distanceTo(b);
      ctl.copy(a).add(b).multiplyScalar(0.5);
      ctl.y += dist * 0.32 + Math.max(a.y, b.y) * 0.5 + 1.2;
      var base = l.type === 'out' ? PAL.out : l.type === 'in' ? PAL.inn : neutral;
      var alpha = (l.type === 'top' ? 0.28 : 0.45) + 0.55 * l.s;
      if (l.hop > 1) alpha *= 0.65;
      for (var s = 0; s < ARC_SEGS; s++) {
        var t0 = s / ARC_SEGS, t1 = (s + 1) / ARC_SEGS;
        bez(a, ctl, b, t0, p); bez(a, ctl, b, t1, q);
        var o = (li * ARC_SEGS + s) * 2;
        pos.set([p.x, p.y, p.z, q.x, q.y, q.z], o * 3);
        for (var v = 0; v < 2; v++) {
          colr.set([base.r, base.g, base.b, alpha], (o + v) * 4);
          tt[o + v] = v === 0 ? t0 : t1;
        }
      }
      endPos.set([b.x, b.y, b.z], li * 3);
      endCol.set([base.r, base.g, base.b], li * 3);
    });

    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(colr, 4));
    g.setAttribute('aT', new THREE.BufferAttribute(tt, 1));
    var mat = new THREE.ShaderMaterial({
      vertexShader: arcVert, fragmentShader: arcFrag, transparent: true, depthWrite: false,
      uniforms: { uProgress: { value: motionOk() ? 0 : 1 } }
    });
    R.arcs = new THREE.LineSegments(g, mat);
    R.arcs.frustumCulled = false;
    R.arcs.renderOrder = 5;
    R.scene.add(R.arcs);

    var eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(endPos, 3));
    eg.setAttribute('color', new THREE.BufferAttribute(endCol, 3));
    R.ends = new THREE.Points(eg, new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, depthWrite: false }));
    R.ends.renderOrder = 6;
    R.ends.frustumCulled = false;
    R.scene.add(R.ends);

    drawOn = motionOk() ? { t0: performance.now(), dur: 650 } : null;
    invalidate();
  }

  function bez(a, c, b, t, out) {
    var u = 1 - t;
    out.set(u * u * a.x + 2 * u * t * c.x + t * t * b.x, u * u * a.y + 2 * u * t * c.y + t * t * b.y, u * u * a.z + 2 * u * t * c.z + t * t * b.z);
  }

  /* ------------------------------------------------------------ camera rig */

  // The part of the window the panels leave free, where the model should sit.
  function freeRect() {
    var W = window.innerWidth, H = window.innerHeight;
    if (W > 1100) {
      var left = $('left').getBoundingClientRect().right + 16;
      var right = W - $('inspector').getBoundingClientRect().left + 16;
      return { x0: left, x1: Math.max(left + 200, W - right), y0: 84, y1: H - 16 };
    }
    // Small screens: the picker is on top; search, tools and the details sheet stack at the bottom.
    var top = $('picker').getBoundingClientRect().bottom + 8;
    var low = Math.min($('toolbar').getBoundingClientRect().top, $('inspector').getBoundingClientRect().top || H);
    return { x0: 8, x1: W - 8, y0: top, y1: Math.max(top + 120, low - 8) };
  }

  /**
   * Frames the whole city inside the area the panels leave free: the smallest
   * zoom-out at which its bounding box fits, then the camera target is nudged
   * until the box is centred in that area rather than in the window.
   */
  function frameWhole(animate) {
    var L = S.layout, fr = freeRect();
    var theta = -0.55, phi = S.topDown ? 0.02 : 0.95;
    var W = window.innerWidth, H = window.innerHeight;
    var cam2 = R.camera.clone();
    var hw = L.width / 2, hd = L.depth / 2, top = 9;
    var pts = [[-hw, 0, -hd], [hw, 0, -hd], [hw, 0, hd], [-hw, 0, hd], [-hw, top, -hd], [hw, top, -hd], [hw, top, hd], [-hw, top, hd]]
      .map(function (p) { return new THREE.Vector3(p[0], p[1], p[2]); });
    var right = new THREE.Vector3(Math.cos(theta), 0, -Math.sin(theta));
    var fwd = new THREE.Vector3(-Math.sin(theta), 0, -Math.cos(theta));

    function box(radius, tx, tz) {
      var sp = Math.sin(phi);
      cam2.position.set(tx + radius * sp * Math.sin(theta), radius * Math.cos(phi), tz + radius * sp * Math.cos(theta));
      cam2.lookAt(tx, 0, tz);
      cam2.updateMatrixWorld(true);
      var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, behind = false;
      pts.forEach(function (p) {
        var v = p.clone().project(cam2);
        if (v.z >= 1) behind = true;
        var x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      });
      return { w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, behind: behind };
    }

    var freeW = fr.x1 - fr.x0, freeH = fr.y1 - fr.y0;
    var lo = 12, hi = Math.max(L.width, L.depth, 30) * 4;
    for (var k = 0; k < 24; k++) {
      var mid = (lo + hi) / 2, bx = box(mid, 0, 0);
      if (!bx.behind && bx.w <= freeW && bx.h <= freeH) hi = mid; else lo = mid;
    }
    var radius = clamp(hi * 1.03, 20, 3500);

    // Centre the box in the free area: measure how the box moves per unit of
    // target travel along the ground axes, then solve for the shift.
    var tx = 0, tz = 0, goalX = (fr.x0 + fr.x1) / 2, goalY = (fr.y0 + fr.y1) / 2;
    for (var it = 0; it < 3; it++) {
      var c0 = box(radius, tx, tz);
      var cR = box(radius, tx + right.x, tz + right.z);
      var cF = box(radius, tx + fwd.x, tz + fwd.z);
      var a11 = cR.cx - c0.cx, a12 = cF.cx - c0.cx, a21 = cR.cy - c0.cy, a22 = cF.cy - c0.cy;
      var det = a11 * a22 - a12 * a21;
      if (Math.abs(det) < 1e-9) break;
      var rx = goalX - c0.cx, ry = goalY - c0.cy;
      var p = (rx * a22 - a12 * ry) / det, q = (a11 * ry - a21 * rx) / det;
      tx += right.x * p + fwd.x * q;
      tz += right.z * p + fwd.z * q;
    }
    setCamTarget({ x: tx, y: 0, z: tz, theta: theta, phi: phi, radius: radius }, animate);
  }

  function setCamTarget(t, animate) {
    cam.to = {
      x: t.x !== undefined ? t.x : cam.to.x, y: t.y !== undefined ? t.y : cam.to.y, z: t.z !== undefined ? t.z : cam.to.z,
      theta: t.theta !== undefined ? t.theta : cam.to.theta,
      phi: t.phi !== undefined ? clamp(t.phi, 0.02, 1.5) : cam.to.phi,
      radius: t.radius !== undefined ? clamp(t.radius, 6, 4000) : cam.to.radius
    };
    if (!animate || !motionOk()) {
      cam.cur = Object.assign({}, cam.to);
    }
    invalidate();
  }

  function stepCamera(dt) {
    var c = cam.cur, t = cam.to, moved = false;
    var k = motionOk() ? 1 - Math.pow(0.0015, dt) : 1;
    ['x', 'y', 'z', 'theta', 'phi', 'radius'].forEach(function (key) {
      var d = t[key] - c[key];
      if (Math.abs(d) > 1e-4 * (key === 'radius' ? Math.max(1, c.radius) : 1)) { c[key] += d * k; moved = true; } else c[key] = t[key];
    });
    var sp = Math.sin(c.phi), cp = Math.cos(c.phi);
    R.camera.position.set(c.x + c.radius * sp * Math.sin(c.theta), c.y + c.radius * cp, c.z + c.radius * sp * Math.cos(c.theta));
    R.camera.lookAt(c.x, c.y, c.z);
    return moved;
  }

  function flyTo(i) {
    var P = S.layout.pos;
    setCamTarget({ x: P.x[i], y: S.heights[i] * 0.4, z: P.z[i], radius: 26 + S.heights[i] * 1.2, phi: S.topDown ? 0.3 : Math.min(cam.to.phi, 1.05) }, true);
  }

  /* ------------------------------------------------------------ render loop */

  function invalidate() {
    dirty = true;
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  function frame(now) {
    rafId = 0;
    var dt = Math.min(0.05, (now - (lastT || now)) / 1000);
    lastT = now;
    var animating = false;

    if (intro) {
      var el = now - intro.t0;
      var maxD = intro.maxD || 1;
      writeMatrices(function (i) {
        var d = intro.delay[i];
        return easeOut(clamp((el - d) / 420, 0, 1));
      });
      if (el > 420 + 520) { intro = null; writeMatrices(function () { return 1; }); }
      animating = true;
    }
    if (drawOn && R.arcs) {
      var p = clamp((now - drawOn.t0) / drawOn.dur, 0, 1);
      R.arcs.material.uniforms.uProgress.value = easeOut(p);
      if (p >= 1) drawOn = null;
      animating = true;
    }
    if (stepCamera(dt || 0.016)) animating = true;

    if (dirty || animating) {
      updateLabels();
      R.renderer.render(R.scene, R.camera);
      dirty = false;
    }
    if (animating) rafId = requestAnimationFrame(frame);
    else lastT = 0;
  }

  /* ------------------------------------------------------------ picking */

  function pickBlock(clientX, clientY) {
    if (!R.pick || !S.model) return -1;
    var w = window.innerWidth, h = window.innerHeight;
    R.camera.setViewOffset(w, h, Math.floor(clientX), Math.floor(clientY), 1, 1);
    var prevColor = R.renderer.getClearColor(new THREE.Color());
    var prevAlpha = R.renderer.getClearAlpha();
    R.renderer.setClearColor(0x000000, 1);
    R.renderer.setRenderTarget(R.pickTarget);
    R.renderer.render(R.pickScene, R.camera);
    R.renderer.readRenderTargetPixels(R.pickTarget, 0, 0, 1, 1, R.pixel);
    R.renderer.setRenderTarget(null);
    R.renderer.setClearColor(prevColor, prevAlpha);
    R.camera.clearViewOffset();
    var v = R.pixel[0] + (R.pixel[1] << 8) + (R.pixel[2] << 16);
    return v > 0 && v <= S.model.n ? v - 1 : -1;
  }

  function plotAt(clientX, clientY) {
    var ndc = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    R.ray.setFromCamera(ndc, R.camera);
    var hit = new THREE.Vector3();
    if (!R.ray.ray.intersectPlane(R.ground, hit)) return null;
    var plots = S.layout.plots;
    for (var i = 0; i < plots.length; i++) {
      var p = plots[i];
      if (hit.x >= p.x && hit.x <= p.x + p.w && hit.z >= p.z && hit.z <= p.z + p.d) return p;
    }
    return null;
  }

  /* ------------------------------------------------------------ labels */

  var districtLabels = [];

  function buildDistrictLabels() {
    var host = $('labels');
    host.innerHTML = '';
    districtLabels = [];
    var total = S.model.n || 1;
    S.layout.districts
      .filter(function (d) { return d.depth <= 3 && d.weight / total >= 0.012; })
      .sort(function (a, b) { return b.weight - a.weight; })
      .slice(0, 90)
      .forEach(function (d) {
        var el = document.createElement('div');
        el.className = 'lbl';
        var short = d.name.split('/').slice(-2).join('/');
        el.textContent = short;
        el.title = d.path;
        el.hidden = true;
        host.appendChild(el);
        districtLabels.push({ d: d, el: el });
      });
    var tag = document.createElement('div');
    tag.className = 'lbl tag';
    tag.hidden = true;
    host.appendChild(tag);
    R.tagEl = tag;
  }

  var vTmp = new THREE.Vector3();
  function project(x, y, z) {
    vTmp.set(x, y, z).project(R.camera);
    return { x: (vTmp.x * 0.5 + 0.5) * window.innerWidth, y: (-vTmp.y * 0.5 + 0.5) * window.innerHeight, z: vTmp.z };
  }

  function updateLabels() {
    if (!S.model || !districtLabels.length) return;
    var W = window.innerWidth, H = window.innerHeight, shown = 0, boxes = [];
    districtLabels.forEach(function (it) {
      var d = it.d;
      var a = project(d.x, 0, d.z), b = project(d.x + d.w, 0, d.z + d.d), c = project(d.x + d.w, 0, d.z), e = project(d.x, 0, d.z + d.d);
      var xs = [a.x, b.x, c.x, e.x], ys = [a.y, b.y, c.y, e.y];
      var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs), minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
      var bw = maxX - minX, bh = maxY - minY;
      var behind = a.z > 1 || b.z > 1 || c.z > 1 || e.z > 1;
      var ok = !behind && bw > 120 + d.depth * 24 && bh > 54 && maxX > 0 && minX < W && maxY > 0 && minY < H && shown < 36;
      if (ok) {
        var x = clamp(minX + 6, 4, W - 150), y = clamp(minY + 6, 70, H - 40);
        var clash = boxes.some(function (bx) { return Math.abs(bx.x - x) < 130 && Math.abs(bx.y - y) < 24; });
        if (clash) ok = false;
        else { boxes.push({ x: x, y: y }); it.el.style.transform = 'translate(' + x + 'px,' + y + 'px)'; shown++; }
      }
      it.el.hidden = !ok;
    });

    if (R.tagEl) {
      var i = S.selected;
      if (i >= 0 && S.visible[i]) {
        var t = project(S.layout.pos.x[i], S.heights[i] + 0.4, S.layout.pos.z[i]);
        if (t.z < 1) {
          R.tagEl.textContent = S.model.names[i];
          R.tagEl.style.transform = 'translate(' + clamp(t.x + 10, 4, W - 200) + 'px,' + clamp(t.y - 30, 70, H - 40) + 'px)';
          R.tagEl.hidden = false;
        } else R.tagEl.hidden = true;
      } else R.tagEl.hidden = true;
    }
  }

  /* ------------------------------------------------------------ selection */

  function placeBox(box, i) {
    if (i < 0 || !S.visible[i]) { box.visible = false; return; }
    var P = S.layout.pos, sz = P.size[i] * 1.18;
    box.position.set(P.x[i], 0, P.z[i]);
    box.scale.set(sz, S.heights[i] + 0.2, sz);
    box.visible = true;
  }

  function select(i, opts) {
    opts = opts || {};
    if (i === S.selected) return;
    if (!opts.fromHistory && S.selected >= 0) {
      S.history.push(S.selected);
      if (S.history.length > 40) S.history.shift();
    }
    S.selected = i;
    var small = window.innerWidth <= 1100;
    if (small) {
      var ins = $('inspector');
      ins.classList.toggle('collapsed', i < 0);
      $('sheet-toggle').setAttribute('aria-expanded', String(i >= 0));
      if (i >= 0) setOptionsQuiet(false);
    }
    placeBox(R.selBox, i);
    rebuildArcs();
    applyColors();
    renderInspector();
    syncHash();
    if (i >= 0) {
      if (opts.fly !== false) flyTo(i);
      announce(S.model.names[i] + ', ' + S.model.kinds[i] + ' in ' + S.model.paths[S.model.fileOf[i]] + '. ' +
        (focus.callers ? focus.callers.size : 0) + ' callers shown, ' + (focus.callees ? focus.callees.size : 0) + ' calls shown.');
    } else announce('Selection cleared.');
    invalidate();
  }

  function setOptionsQuiet(open) {
    document.body.classList.toggle('opts-open', open);
    $('btn-opts').setAttribute('aria-pressed', String(open));
  }

  function announce(text) { $('live').textContent = text; }

  function toast(text) {
    var el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { el.hidden = true; }, 2200);
  }

  /* ------------------------------------------------------------ inspector */

  function kindDot(kind) { return '<span class="dot" style="background:var(--k-' + (KINDS.indexOf(kind) >= 0 ? kind : 'file') + ')"></span>'; }
  function kindChip(kind) { return '<span class="chip">' + kindDot(kind) + esc(kind) + '</span>'; }

  function linkList(links, dir, total) {
    var m = S.model;
    if (!links.length) {
      if (!total) return '<p class="empty-note">' + (dir === 'in' ? 'Nothing in this build calls it.' : 'It does not call anything in this build.') + '</p>';
      return '<p class="empty-note">None at this link strength. Lower “Hide weak links” to see ' + total + ' weaker.</p>';
    }
    var rows = links.slice(0, 40).map(function (l) {
      var i = l.node;
      return '<li class="dir-' + dir + '"><button type="button" data-idx="' + i + '">' + kindDot(m.kinds[i]) +
        '<span class="nm">' + esc(m.names[i]) + '<span class="fl">' + (l.via >= 0 && l.via !== S.selected ? 'via ' + esc(m.names[l.via]) + ' · ' : '') + esc(m.paths[m.fileOf[i]]) + '</span></span>' +
        '<span class="bar" title="Link strength ' + Math.round(l.strength * 100) + '%"><i style="width:' + Math.round(l.strength * 100) + '%"></i></span></button></li>';
    }).join('');
    var more = links.length > 40 ? '<p class="empty-note">Showing the 40 strongest of ' + links.length + '.</p>' : '';
    return '<ul class="list">' + rows + '</ul>' + more;
  }

  function renderInspector() {
    var body = $('inspector-body'), m = S.model;
    if (!m) { body.innerHTML = ''; return; }
    var i = S.selected;

    if (i < 0) {
      var snapInfo = S.snap;
      var marks = Core.landmarks(m, 8);
      var html = '<div><h2 class="ins-title">' + esc(snapInfo.name) + '</h2>' +
        '<p class="ins-sub">Built ' + esc(when(snapInfo.builtAt)) + '</p>' +
        (snapInfo.rootDir ? '<p class="ins-path">' + esc(snapInfo.rootDir) + '</p>' : '') + '</div>' +
        '<dl class="stats"><div><dt>Files</dt><dd>' + fmt(S.layout.plots.length) + '</dd></div><div><dt>Symbols</dt><dd>' + fmt(m.n) + '</dd></div><div><dt>Links</dt><dd>' + fmt(m.edgeCount) + '</dd></div></dl>';
      if (S.compare && S.diff) html += changesSection();
      html += '<div><h3 class="ins-h">Most depended on <small>strong links only</small></h3>' +
        (marks.length ? '<ul class="list dir-in">' + marks.map(function (k) {
          return '<li><button type="button" data-idx="' + k + '">' + kindDot(m.kinds[k]) + '<span class="nm">' + esc(m.names[k]) +
            '<span class="fl">' + esc(m.paths[m.fileOf[k]]) + '</span></span><span class="chip" title="Weighted number of callers">' + (Math.round(m.fanIn[k] * 10) / 10) + '</span></button></li>';
        }).join('') + '</ul>' : '<p class="empty-note">No linked symbols in this build.</p>') + '</div>' +
        '<p class="note">Select a block, or search above, to see its callers and calls. Press <kbd>?</kbd> for help.</p>';
      body.innerHTML = html;
      return;
    }

    var around = Core.neighborhood(m, i, S.hops, S.minStrength, 120);
    var loc = m.paths[m.fileOf[i]] + ':' + m.startLine[i] + (m.endLine[i] !== m.startLine[i] ? '-' + m.endLine[i] : '');
    var html2 = '<div><div class="row"><button type="button" class="link-btn" id="ins-back">' + (S.history.length ? 'Back' : 'Overview') + '</button></div>' +
      '<h2 class="ins-title mono">' + esc(m.names[i]) + '</h2>' +
      '<div class="row" style="margin-top:8px">' + kindChip(m.kinds[i]) + '</div>' +
      '<p class="ins-path">' + esc(loc) + '</p></div>';
    if (m.sigs[i]) html2 += '<pre class="sig">' + esc(m.sigs[i]) + '</pre>';
    var rolled = Core.rolledCounts(m, i);
    if (around.members.length) html2 += '<p class="note">Includes its ' + around.members.length + ' method' + (around.members.length === 1 ? '' : 's') + ': calls are recorded against methods, so they are counted here.</p>';
    html2 += '<dl class="stats"><div><dt>Lines</dt><dd>' + fmt(m.endLine[i] - m.startLine[i] + 1) + '</dd></div>' +
      '<div><dt>Callers</dt><dd>' + fmt(rolled.callers) + '</dd></div><div><dt>Calls</dt><dd>' + fmt(rolled.calls) + '</dd></div></dl>' +
      '<div class="row"><button type="button" class="small-btn" data-copy="' + esc(loc) + '">Copy path and line</button>' +
      '<button type="button" class="small-btn" data-copy="' + m.ids[i] + '">Copy symbol id</button></div>' +
      '<div><h3 class="ins-h">Called by <small>' + around.callers.length + ' shown</small></h3>' + linkList(around.callers, 'in', rolled.callers) + '</div>' +
      '<div><h3 class="ins-h">Calls <small>' + around.callees.length + ' shown</small></h3>' + linkList(around.callees, 'out', rolled.calls) + '</div>';
    body.innerHTML = html2;
    body.scrollTop = 0;
  }

  function changesSection() {
    var d = S.diff, other = S.other;
    var label = other.which;
    var removed = d.removed.slice(0, 30).map(function (r) {
      return '<li><span class="nm" style="display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:center;padding:6px 10px">' + kindDot(r.kind) +
        '<span class="nm">' + esc(r.name) + '<span class="fl">' + esc(r.path) + '</span></span></span></li>';
    }).join('');
    return '<div><h3 class="ins-h">Changes <small>against the ' + esc(label) + ' build</small></h3>' +
      '<dl class="stats" style="grid-template-columns:1fr 1fr"><div><dt>Only in this build</dt><dd style="color:var(--new)">' + fmt(d.addedCount) + '</dd></div>' +
      '<div><dt>Only in the ' + esc(label) + ' build</dt><dd>' + fmt(d.removedCount) + '</dd></div></dl>' +
      (d.removedCount ? '<h4 class="ins-h" style="margin-top:12px;font-size:13px">Missing here <small>' + (d.removedCount > 30 ? 'first 30' : '') + '</small></h4><ul class="list">' + removed + '</ul>' : '') + '</div>';
  }

  /* ------------------------------------------------------------ search */

  var searchState = { results: [], active: -1 };

  function runSearch() {
    var q = $('search').value.trim();
    var box = $('results'), input = $('search');
    if (!q || !S.model) { closeResults(); return; }
    var hits = Core.search(S.model, q, 30);
    searchState.results = hits;
    searchState.active = hits.length ? 0 : -1;
    var m = S.model;
    box.innerHTML = hits.length ? hits.map(function (i, k) {
      return '<li role="option" id="opt-' + k + '" data-idx="' + i + '" aria-selected="' + (k === 0) + '">' +
        '<span class="r-name">' + esc(m.names[i]) + '</span>' + kindChip(m.kinds[i]) +
        '<span class="r-path"><bdi>' + esc(m.paths[m.fileOf[i]]) + '</bdi></span></li>';
    }).join('') : '<li class="r-empty" role="option" aria-disabled="true">Nothing matches “' + esc(q) + '”. Try part of a name, or a folder name.</li>';
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', hits.length ? 'opt-0' : '');
    announce(hits.length + ' matches');
  }

  function closeResults() {
    $('results').hidden = true;
    $('search').setAttribute('aria-expanded', 'false');
    $('search').removeAttribute('aria-activedescendant');
    searchState.results = [];
  }

  function moveActive(delta) {
    var n = searchState.results.length;
    if (!n) return;
    searchState.active = (searchState.active + delta + n) % n;
    Array.prototype.forEach.call($('results').children, function (li, k) { li.setAttribute('aria-selected', String(k === searchState.active)); });
    var li = $('opt-' + searchState.active);
    $('search').setAttribute('aria-activedescendant', 'opt-' + searchState.active);
    if (li) li.scrollIntoView({ block: 'nearest' });
  }

  function chooseResult(i) {
    closeResults();
    $('search').value = '';
    $('search').blur();
    if (i >= 0) select(i);
  }

  /* ------------------------------------------------------------ repo and version pickers */

  function fillRepoSelect() {
    var sel = $('repo');
    var names = {};
    S.index.repos.forEach(function (r) { names[r.name] = (names[r.name] || 0) + 1; });
    sel.innerHTML = S.index.repos.map(function (r) {
      var label = r.name;
      if (names[r.name] > 1 && r.rootDir) label += ' (' + String(r.rootDir).split(/[\\/]/).filter(Boolean).slice(-3, -1).join('/') + ')';
      if (!r.versions.length) label += ' (not indexed yet)';
      return '<option value="' + esc(r.repoId) + '">' + esc(label) + '</option>';
    }).join('');
  }

  function fillVersionSelect(repo, selected) {
    var sel = $('version');
    if (!repo.versions.length) {
      sel.innerHTML = '<option>No build yet</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.innerHTML = repo.versions.map(function (v, k) {
      return '<option value="' + esc(v.id) + '">' + (k === 0 ? 'Latest' : 'Previous') + ' · ' + esc(when(v.builtAt)) + ' · ' + fmt(v.counts.symbols) + ' symbols</option>';
    }).join('');
    sel.value = selected;
  }

  function updateCompareButton(repo) {
    var btn = $('compare'), note = $('compare-note');
    var can = repo && repo.versions.length > 1;
    btn.disabled = !can;
    btn.setAttribute('aria-pressed', String(S.compare && can));
    note.hidden = can;
    note.textContent = can ? '' : (repo && repo.versions.length === 1 ? 'Rebuild this repository once more to compare two builds. The two most recent are kept.' : '');
    btn.querySelector('.btn-label').textContent = S.compare && can ? 'Showing changes' : 'Highlight changes';
  }

  /* ------------------------------------------------------------ overlay */

  function showOverlay(o) {
    var ov = $('overlay');
    ov.hidden = false;
    ov.classList.remove('gone');
    ov.classList.toggle('static', !!o.static);
    $('overlay-title').textContent = o.title;
    $('overlay-text').innerHTML = o.html || esc(o.text || '');
    $('overlay-actions').innerHTML = '';
    (o.actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn' + (a.primary ? ' primary' : ''); b.textContent = a.label;
      b.addEventListener('click', a.run);
      $('overlay-actions').appendChild(b);
    });
  }
  function hideOverlay() {
    var ov = $('overlay');
    ov.classList.add('gone');
    setTimeout(function () { if (ov.classList.contains('gone')) ov.hidden = true; }, 260);
  }

  /* ------------------------------------------------------------ opening a build */

  var openToken = 0;

  function openRepo(repoId, versionId, opts) {
    opts = opts || {};
    var repo = S.index.repos.filter(function (r) { return r.repoId === repoId; })[0];
    if (!repo) return;
    S.repo = repo;
    $('repo').value = repoId;
    var token = ++openToken;

    if (!repo.versions.length) {
      S.model = null; S.snap = null;
      fillVersionSelect(repo);
      updateCompareButton(repo);
      showOverlay({
        title: repo.name + ' has not been indexed yet',
        html: 'There is nothing to draw. Build it first, then reopen this page:<br><br><code>brain build ' + esc(repo.rootDir || '<path to repository>') + '</code>',
        static: true,
        actions: [{ label: 'Choose another repository', run: function () { $('repo').focus(); hideOverlay(); } }]
      });
      renderEmpty();
      return;
    }

    var vId = versionId && repo.versions.some(function (v) { return v.id === versionId; }) ? versionId : repo.versions[0].id;
    S.versionId = vId;
    fillVersionSelect(repo, vId);
    var meta = repo.versions.filter(function (v) { return v.id === vId; })[0];
    showOverlay({ title: 'Opening ' + repo.name, text: fmt(meta.counts.symbols) + ' symbols and ' + fmt(meta.counts.edges) + ' links' });

    loadSnapshot(repoId, vId).then(function (snap) {
      if (token !== openToken) return;
      // Let the loading card paint before the synchronous model and layout work.
      return new Promise(function (r) { setTimeout(r, 30); }).then(function () {
        if (token !== openToken) return;
        S.snap = snap;
        S.model = Core.buildModel(snap);
        S.layout = Core.layoutCity(S.model);
        S.selected = -1; S.history = []; focus.callees = focus.callers = null;
        S.other = null; S.diff = null;
        S.kindOn = {};
        KINDS.concat(['other']).forEach(function (k) { S.kindOn[k] = true; });
        renderKinds();
        buildScene();
        beginIntro();
        frameWhole(false);
        renderInspector();
        updateCompareButton(repo);
        hideOverlay();
        syncHash();
        announce('Opened ' + repo.name + ', ' + fmt(S.model.n) + ' symbols.');
        if (opts.symbolId) {
          var idx = S.model.indexById.get(Number(opts.symbolId));
          if (idx !== undefined) select(idx);
        }
        if (opts.compare && repo.versions.length > 1) setCompare(true);
        else if (S.compare && repo.versions.length > 1) setCompare(true);
        else { S.compare = false; updateCompareButton(repo); }
        if (!store('brain-help-seen')) { store('brain-help-seen', '1'); toast('Press ? any time for help'); }
      });
    }).catch(function (err) {
      if (token !== openToken) return;
      showOverlay({
        title: 'Could not open this build',
        text: err.message + '. The file may have been removed by a newer build. Reload to see the current builds.',
        static: true,
        actions: [{ label: 'Reload', primary: true, run: function () { location.reload(); } }]
      });
    });
  }

  function renderEmpty() {
    ['blocks', 'plots', 'plotLines', 'districtLines', 'arcs', 'ends', 'selBox', 'hoverBox'].forEach(function (k) { if (R[k]) { disposeObject(R[k]); R[k] = null; } });
    R.pickScene.children.slice().forEach(function (c) { R.pickScene.remove(c); });
    $('labels').innerHTML = '';
    $('inspector-body').innerHTML = '<p class="empty-note">Nothing to show for this repository yet.</p>';
    invalidate();
  }

  function beginIntro() {
    var m = S.model, P = S.layout.pos;
    var maxD = Math.max(1, Math.hypot(S.layout.width, S.layout.depth) / 2);
    if (!motionOk() || m.n > 60000) { writeMatrices(function () { return 1; }); invalidate(); return; }
    var delay = new Float32Array(m.n);
    for (var i = 0; i < m.n; i++) delay[i] = (Math.hypot(P.x[i], P.z[i]) / maxD) * 520;
    intro = { t0: performance.now(), delay: delay, maxD: maxD };
    invalidate();
  }

  /* ------------------------------------------------------------ compare */

  function setCompare(on) {
    var repo = S.repo;
    if (!repo || repo.versions.length < 2) { S.compare = false; updateCompareButton(repo); return; }
    S.compare = on;
    if (!on) {
      S.diff = null; S.other = null;
      applyColors(); renderInspector(); updateCompareButton(repo); syncHash();
      return;
    }
    var idx = repo.versions.map(function (v) { return v.id; }).indexOf(S.versionId);
    var otherMeta = repo.versions[idx === 0 ? 1 : 0];
    var which = idx === 0 ? 'previous' : 'latest';
    $('compare').disabled = true;
    loadSnapshot(repo.repoId, otherMeta.id).then(function (snap) {
      S.other = { which: which, meta: otherMeta };
      S.diff = Core.diffVersions(S.model, Core.buildModel(snap));
      $('compare').disabled = false;
      applyColors(); renderInspector(); updateCompareButton(repo); syncHash();
      announce(S.diff.addedCount + ' symbols only in this build, ' + S.diff.removedCount + ' only in the ' + which + ' build.');
      if (motionOk()) pulseChanged();
    }).catch(function (err) {
      S.compare = false; $('compare').disabled = false; updateCompareButton(repo);
      toast('Could not load the ' + which + ' build: ' + err.message);
    });
  }

  // Changed blocks rise from the ground once, so the difference is felt, not just coloured.
  function pulseChanged() {
    var m = S.model, delay = new Float32Array(m.n);
    var any = false;
    for (var i = 0; i < m.n; i++) { if (S.diff.added[i]) { delay[i] = 0; any = true; } else delay[i] = -1; }
    if (!any) return;
    var t0 = performance.now();
    var tick = function (now) {
      var p = clamp((now - t0) / 700, 0, 1);
      writeMatrices(function (i) { return delay[i] === 0 ? 0.15 + 0.85 * easeOut(p) : 1; });
      invalidate();
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------ hash */

  function syncHash() {
    if (!S.repo) return;
    var parts = ['r=' + encodeURIComponent(S.repo.repoId)];
    if (S.versionId) parts.push('v=' + encodeURIComponent(S.versionId));
    if (S.selected >= 0) parts.push('s=' + S.model.ids[S.selected]);
    if (S.compare) parts.push('c=1');
    try { history.replaceState(null, '', '#' + parts.join('&')); } catch (_) { /* file:// restrictions */ }
  }

  function readHash() {
    var out = {};
    location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
      var p = kv.split('=');
      if (p[0]) out[p[0]] = decodeURIComponent(p[1] || '');
    });
    return out;
  }

  /* ------------------------------------------------------------ controls */

  function renderKinds() {
    var counts = {};
    S.model.kinds.forEach(function (k) { var key = kindKey(k); counts[key] = (counts[key] || 0) + 1; });
    $('kinds').innerHTML = KINDS.concat(['other']).filter(function (k) { return counts[k]; }).map(function (k) {
      return '<label><input type="checkbox" data-kind="' + k + '" checked><span class="dot" style="background:var(--k-' + (k === 'other' ? 'file' : k) + ')"></span>' +
        esc(KIND_LABEL[k]) + '<span class="cnt">' + fmt(counts[k]) + '</span></label>';
    }).join('');
  }

  function setHeightMode(mode) {
    S.heightMode = mode;
    if (!S.model) return;
    computeHeights();
    writeMatrices(function () { return 1; });
    placeBox(R.selBox, S.selected);
    rebuildArcs();
    invalidate();
  }

  function refreshLinks() {
    if (!S.model) return;
    rebuildArcs();
    if (S.selected >= 0) { applyColors(); renderInspector(); }
  }

  function bindControls() {
    $('repo').addEventListener('change', function (e) { S.compare = false; openRepo(e.target.value); });
    $('version').addEventListener('change', function (e) { S.compare = $('compare').getAttribute('aria-pressed') === 'true'; openRepo(S.repo.repoId, e.target.value); });
    $('compare').addEventListener('click', function () { setCompare(!S.compare); });

    Array.prototype.forEach.call(document.querySelectorAll('input[name="height"]'), function (r) {
      r.addEventListener('change', function () { if (r.checked) setHeightMode(r.value); });
    });
    $('strength').addEventListener('input', function (e) {
      S.minStrength = Number(e.target.value) / 100;
      $('strength-out').textContent = e.target.value + '%';
      refreshLinks();
    });
    $('top-on').addEventListener('change', function (e) { S.showTop = e.target.checked; refreshLinks(); });
    $('top-count').addEventListener('input', function (e) { S.topCount = Number(e.target.value); if (S.showTop) refreshLinks(); });
    $('hops').addEventListener('input', function (e) {
      S.hops = Number(e.target.value);
      $('hops-out').textContent = S.hops + (S.hops === 1 ? ' step' : ' steps');
      refreshLinks();
    });
    $('kinds').addEventListener('change', function (e) {
      var k = e.target.getAttribute('data-kind');
      if (!k) return;
      S.kindOn[k] = e.target.checked;
      computeVisibility();
      writeMatrices(function () { return 1; });
      if (S.selected >= 0 && !S.visible[S.selected]) select(-1); else { placeBox(R.selBox, S.selected); rebuildArcs(); }
      invalidate();
    });

    $('btn-tilt').addEventListener('click', toggleTopDown);
    $('btn-reset').addEventListener('click', function () { frameWhole(true); });
    $('btn-theme').addEventListener('click', function () { applyTheme(S.theme === 'dark' ? 'light' : 'dark'); });
    $('btn-help').addEventListener('click', openHelp);
    $('btn-opts').addEventListener('click', function () { setOptions(!document.body.classList.contains('opts-open')); });
    $('opts-close').addEventListener('click', function () { setOptions(false); });
    $('sheet-toggle').addEventListener('click', function () {
      var ins = $('inspector'), collapsed = ins.classList.toggle('collapsed');
      $('sheet-toggle').setAttribute('aria-expanded', String(!collapsed));
    });

    var search = $('search');
    var timer = 0;
    search.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(runSearch, 50); });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if ($('results').hidden) runSearch(); else moveActive(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (searchState.results.length) chooseResult(searchState.results[searchState.active]); }
      else if (e.key === 'Escape') { if (!$('results').hidden) { e.preventDefault(); e.stopPropagation(); closeResults(); } else { search.value = ''; search.blur(); } }
    });
    search.addEventListener('focus', function () { if (search.value.trim()) runSearch(); });
    $('results').addEventListener('mousedown', function (e) {
      var li = e.target.closest('li[data-idx]');
      if (li) { e.preventDefault(); chooseResult(Number(li.getAttribute('data-idx'))); }
    });
    document.addEventListener('mousedown', function (e) { if (!e.target.closest('#searchbox')) closeResults(); });

    $('inspector-body').addEventListener('click', function (e) {
      var go = e.target.closest('[data-idx]');
      if (go) { select(Number(go.getAttribute('data-idx'))); return; }
      var cp = e.target.closest('[data-copy]');
      if (cp) { copyText(cp.getAttribute('data-copy')); return; }
      if (e.target.closest('#ins-back')) goBack();
    });
  }

  function copyText(text) {
    var done = function () { toast('Copied ' + text); };
    if (navigator.clipboard && window.isSecureContext !== false) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (_) { /* nothing more to try */ }
    ta.remove();
  }

  function goBack() {
    if (S.history.length) select(S.history.pop(), { fromHistory: true });
    else select(-1);
  }

  function toggleTopDown() {
    S.topDown = !S.topDown;
    $('btn-tilt').setAttribute('aria-pressed', String(S.topDown));
    setCamTarget({ phi: S.topDown ? 0.02 : 0.95 }, true);
    announce(S.topDown ? 'Top-down view' : 'Tilted view');
  }

  function setOptions(open) {
    document.body.classList.toggle('opts-open', open);
    $('btn-opts').setAttribute('aria-pressed', String(open));
    if (open) $('opts-close').focus();
    setTimeout(function () { if (S.model) frameFor(); }, 0);
  }

  function frameFor() { /* the free area changed; the camera is left where the person put it */ invalidate(); }

  function openHelp() { var d = $('help'); if (!d.open) d.showModal(); }

  /* ------------------------------------------------------------ pointer and keyboard */

  var drag = null, pointers = new Map(), hoverRaf = 0, lastMove = null;

  function bindStage() {
    var canvas = $('stage');
    canvas.addEventListener('pointerdown', function (e) {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, pan: e.button === 2 || e.shiftKey || e.ctrlKey || e.button === 1, moved: false, pinch: pointers.size === 2 ? pinchState() : null };
      canvas.classList.add('dragging');
      $('tip').hidden = true;
    });
    canvas.addEventListener('pointermove', function (e) {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (drag) {
        if (pointers.size >= 2) { doPinch(); return; }
        var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX; drag.y = e.clientY;
        if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) drag.moved = true;
        if (!drag.moved) return;
        if (drag.pan) panBy(dx, dy);
        else { setCamTarget({ theta: cam.to.theta - dx * 0.0062, phi: cam.to.phi - dy * 0.0062 }, false); cam.cur.theta = cam.to.theta; cam.cur.phi = cam.to.phi; }
        invalidate();
      } else {
        lastMove = { x: e.clientX, y: e.clientY };
        if (!hoverRaf) hoverRaf = requestAnimationFrame(doHover);
      }
    });
    function end(e) {
      var wasClick = drag && !drag.moved && pointers.size <= 1 && e.type === 'pointerup';
      pointers.delete(e.pointerId);
      canvas.classList.remove('dragging');
      if (wasClick && S.model) {
        var i = pickBlock(e.clientX, e.clientY);
        if (i >= 0 && S.visible[i]) select(i, { fly: false });
        else if (S.selected >= 0) select(-1);
      }
      if (!pointers.size) drag = null;
      else drag = null;
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', function () { $('tip').hidden = true; setHover(-1); });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var f = Math.exp(clamp(e.deltaY, -240, 240) * 0.0017);
      setCamTarget({ radius: cam.to.radius * f }, true);
    }, { passive: false });
    canvas.addEventListener('dblclick', function (e) {
      if (!S.model) return;
      var i = pickBlock(e.clientX, e.clientY);
      if (i >= 0 && S.visible[i]) { if (S.selected !== i) select(i, { fly: false }); flyTo(i); }
    });
  }

  function pinchState() {
    var pts = Array.from(pointers.values());
    return { dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), cx: (pts[0].x + pts[1].x) / 2, cy: (pts[0].y + pts[1].y) / 2 };
  }
  function doPinch() {
    if (!drag.pinch) drag.pinch = pinchState();
    var now = pinchState();
    setCamTarget({ radius: cam.to.radius * (drag.pinch.dist / Math.max(20, now.dist)) }, false);
    cam.cur.radius = cam.to.radius;
    panBy(now.cx - drag.pinch.cx, now.cy - drag.pinch.cy);
    drag.pinch = now;
    drag.moved = true;
  }

  function panBy(dx, dy) {
    var k = cam.to.radius * 0.0016;
    var right = new THREE.Vector3(Math.cos(cam.to.theta), 0, -Math.sin(cam.to.theta));
    var fwd = new THREE.Vector3(-Math.sin(cam.to.theta), 0, -Math.cos(cam.to.theta));
    cam.to.x -= (right.x * dx - fwd.x * dy) * k; cam.to.z -= (right.z * dx - fwd.z * dy) * k;
    cam.cur.x = cam.to.x; cam.cur.z = cam.to.z;
    invalidate();
  }

  function doHover() {
    hoverRaf = 0;
    if (!lastMove || drag || !S.model) return;
    var i = pickBlock(lastMove.x, lastMove.y);
    setHover(i);
    var tip = $('tip'), m = S.model;
    if (i >= 0 && S.visible[i]) {
      var rc = Core.rolledCounts(m, i);
      tip.innerHTML = '<b>' + esc(m.names[i]) + '</b> <span class="chip">' + esc(m.kinds[i]) + '</span>' +
        '<div class="tp">' + esc(m.paths[m.fileOf[i]]) + ':' + m.startLine[i] + '</div>' +
        '<div class="tp">' + fmt(rc.callers) + ' callers · ' + fmt(rc.calls) + ' calls</div>';
    } else {
      var plot = plotAt(lastMove.x, lastMove.y);
      if (plot) tip.innerHTML = '<div class="tp" style="color:var(--ink)">' + esc(m.paths[plot.fileIdx]) + '</div>';
      else { tip.hidden = true; return; }
    }
    tip.hidden = false;
    var tx = Math.min(lastMove.x + 16, window.innerWidth - 360), ty = Math.min(lastMove.y + 18, window.innerHeight - 90);
    tip.style.left = tx + 'px'; tip.style.top = ty + 'px';
  }

  function setHover(i) {
    var v = i >= 0 && S.visible && S.visible[i] ? i : -1;
    if (v === S.hover) return;
    S.hover = v;
    placeBox(R.hoverBox, v === S.selected ? -1 : v);
    $('stage').classList.toggle('over-block', v >= 0);
    invalidate();
  }

  function bindKeys() {
    window.addEventListener('keydown', function (e) {
      var t = e.target, tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'BUTTON' && e.key === ' ') || $('help').open) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var step = e.shiftKey ? 70 : 28;
      switch (e.key) {
        case '/': e.preventDefault(); $('search').focus(); $('search').select(); break;
        case 'Escape': if (document.body.classList.contains('opts-open')) setOptions(false); else if (S.selected >= 0) select(-1); break;
        case '?': openHelp(); break;
        case 't': case 'T': toggleTopDown(); break;
        case 'r': case 'R': frameWhole(true); break;
        case 'c': case 'C': if (!$('compare').disabled) setCompare(!S.compare); break;
        case '[': goBack(); break;
        case '+': case '=': setCamTarget({ radius: cam.to.radius * 0.8 }, true); break;
        case '-': case '_': setCamTarget({ radius: cam.to.radius * 1.25 }, true); break;
        case 'ArrowLeft': e.preventDefault(); panBy(step, 0); break;
        case 'ArrowRight': e.preventDefault(); panBy(-step, 0); break;
        case 'ArrowUp': e.preventDefault(); panBy(0, step); break;
        case 'ArrowDown': e.preventDefault(); panBy(0, -step); break;
        default: break;
      }
    });
  }

  /* ------------------------------------------------------------ start */

  function start() {
    var saved = store('brain-theme');
    var theme = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
    PAL = palette();
    S.theme = theme;

    if (!window.THREE) {
      showOverlay({ title: 'The 3D library is missing', text: 'vendor/three.min.js was not found next to this page. Run brain view again to restore it.', static: true });
      return;
    }
    if (!initRenderer()) return;
    R.scene.background = PAL.group;
    cam.cur = { x: 0, y: 0, z: 0, theta: -0.55, phi: 0.95, radius: 160 };
    cam.to = Object.assign({}, cam.cur);
    resize();
    window.addEventListener('resize', resize);
    bindControls();
    bindStage();
    bindKeys();
    applyTheme(theme);

    var usable = S.index.repos.filter(function (r) { return r.versions.length; });
    if (!S.index.repos.length) {
      showOverlay({
        title: 'No repositories to show',
        html: 'Index a repository first, then run <code>brain view</code> again:<br><br><code>brain build &lt;path to repository&gt;</code>',
        static: true
      });
      return;
    }
    if (window.innerWidth <= 1100) { $('inspector').classList.add('collapsed'); $('sheet-toggle').setAttribute('aria-expanded', 'false'); }
    fillRepoSelect();
    var h = readHash();
    var first = (h.r && S.index.repos.some(function (r) { return r.repoId === h.r; })) ? h.r : (usable[0] || S.index.repos[0]).repoId;
    openRepo(first, h.v, { symbolId: h.s, compare: h.c === '1' });
  }

  window.BrainViewer = {
    state: S, core: Core,
    select: function (i) { select(i); },
    open: openRepo,
    search: function (q) { return Core.search(S.model, q, 30); },
    setCompare: setCompare,
    pick: pickBlock,
    screenOf: function (i) { return project(S.layout.pos.x[i], S.heights[i], S.layout.pos.z[i]); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
