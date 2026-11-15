'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { GraphStore } = require('../src/graphStore');
const { generateCityViewer } = require('../src/visualizeCity');
const { tempDir, parsedSymbols } = require('./helpers');

function withHome(fn) {
  const home = tempDir('brain-city-');
  const prev = process.env.BRAIN_HOME;
  process.env.BRAIN_HOME = home.dir;
  try {
    return fn(home.dir);
  } finally {
    if (prev === undefined) delete process.env.BRAIN_HOME;
    else process.env.BRAIN_HOME = prev;
    home.cleanup();
  }
}

test('generateCityViewer writes a self-contained folder: page, scripts, three.js and data', () =>
  withHome((home) => {
    const dir = path.join(home, 'shop-aaaa1111');
    fs.mkdirSync(dir);
    const store = new GraphStore(dir);
    store.upsertFile('src/a.js', 'h', 1, '.js', parsedSymbols([{ name: 'a' }, { name: 'b' }]));
    store.close();
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ rootDir: '/work/shop', builtAt: '2026-10-01T09:00:00.000Z', files: {} }));

    const out = generateCityViewer();
    assert.equal(path.basename(out.indexHtml), 'index.html');
    assert.equal(out.repos[0].versions.length, 1);

    // every local file the page references exists next to it
    const html = fs.readFileSync(out.indexHtml, 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^":#]+\.(?:js|css))"/g)].map((m) => m[1]);
    assert.ok(refs.includes('vendor/three.min.js') && refs.includes('app.js') && refs.includes('core.js') && refs.includes('index.js'));
    for (const ref of refs) assert.ok(fs.existsSync(path.join(out.dir, ref)), `${ref} is missing from the viewer folder`);

    // and the snapshot the page would request is there
    const v = out.repos[0].versions[0];
    assert.ok(fs.existsSync(path.join(out.dir, 'repos', 'shop-aaaa1111', `${v.id}.js`)));
  }));

test('running it again refreshes the viewer files without duplicating data', () =>
  withHome((home) => {
    const first = generateCityViewer();
    const second = generateCityViewer();
    assert.equal(first.dir, second.dir);
    assert.deepEqual(second.repos, []);
  }));
