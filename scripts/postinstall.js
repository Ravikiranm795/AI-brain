'use strict';

console.log(`
Project Brain installed.

Next steps:
  1. cd into any repo
  2. run:  brain build
  3. run:  brain search "something you're looking for"

The first "brain build" on any repo will download a small local embedding
model (~90MB, one-time, cached afterwards) - it needs internet access once.
Everything after that runs fully offline.
`);
