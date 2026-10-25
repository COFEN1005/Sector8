const assert = require('node:assert/strict');
const { createState, advance } = require('../tutorial');

let state = createState();
assert.equal(state.step, 0);
state = advance(state, { type: 'cell', row: 0, col: 0 }).state;
assert.equal(state.step, 0, 'unrelated cell cannot advance selection');
state = advance(state, { type: 'cell', row: 5, col: 3 }).state;
assert.equal(state.step, 1);
state = advance(state, { type: 'cell', row: 3, col: 3 }).state;
assert.equal(state.step, 2);
assert.equal(state.actions, 1);
state = advance(state, { type: 'cell', row: 3, col: 1 }).state;
assert.equal(state.step, 2, 'enemy cannot be captured without selecting the second unit');
state = advance(state, { type: 'cell', row: 5, col: 1 }).state;
assert.equal(state.selected, 'otsu');
state = advance(state, { type: 'cell', row: 3, col: 1 }).state;
assert.equal(state.step, 3);
assert.equal(state.actions, 2);
assert.equal(state.enemyAlive, false);
state = advance(state, { type: 'answer', value: 'safe' }).state;
assert.equal(state.step, 3, 'wrong answer does not advance');
state = advance(state, { type: 'answer', value: 'collapse' }).state;
assert.equal(state.step, 4);
state = advance(state, { type: 'answer', value: 'core' }).state;
assert.equal(state.step, 5);

console.log('Tutorial selection, movement, capture, and lesson progression verified.');
