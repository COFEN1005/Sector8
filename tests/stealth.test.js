const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
assert.match(html, /data-ability="隠密"/);
assert.match(html, /PASSIVE <span>透明<\/span>/);

const context = vm.createContext({
  console,
  window: { location: { search: '' }, addEventListener() {} },
  document: { addEventListener() {}, getElementById() { return null; } },
  localStorage: { getItem() { return null; } },
  URLSearchParams,
  setTimeout,
  clearTimeout
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'), context);
vm.runInContext(`
  gameMode = 'local';
  tutorialMode = true;
  p1Ability = '隠密';
  p2Ability = '千里眼';
  initializeBoards();
  const stealth = new Unit('stealth', 'koh', 1, 'area1', 5, 5);
  const attacker = new Unit('attacker', 'otsu', 2, 'area1', 5, 3);
  addUnitToBoard(stealth, 'area1', 5, 5);
  addUnitToBoard(attacker, 'area1', 5, 3);
  addConsoleLog = () => {};
  playMoveSfx = () => {};
  recordMatchReplayEvent = () => {};
  sendOnlineMessage = () => {};
  advanceTutorialAfterMove = () => {};
  completeUnitAction = () => {};
`, context);

assert.equal(vm.runInContext('stealth.getMovementRange()', context), 3);
assert.equal(vm.runInContext('stealth.getEffectiveMoveType()', context), 'straight');
assert.equal(vm.runInContext('stealth.getVisionRange()', context), 3);
assert.equal(vm.runInContext('getUnitVisionCells(stealth).has("5,7")', context), true);
vm.runInContext('updateStealthAtTurnEnd(1); updateStealthAtTurnEnd(1)', context);
assert.equal(vm.runInContext('stealth.stealthInvisible', context), false);
vm.runInContext('updateStealthAtTurnEnd(1)', context);
assert.equal(vm.runInContext('stealth.stealthInvisible', context), true);
assert.equal(vm.runInContext('isStealthHiddenFromPlayer(stealth, 2)', context), true);
assert.equal(vm.runInContext('getUnitVisionCells(stealth).has("5,7")', context), true, 'invisible Stealth still provides allied vision');
assert.equal(vm.runInContext('hydrateReplayUnit(serializeReplayUnit(stealth)).stealthInvisible', context), true, 'replay preserves invisibility');
assert.equal(vm.runInContext('isUnitVisibleToViewer(stealth, 2, new Set(["5,5"]))', context), false);
assert.equal(vm.runInContext('getUnitVisionCells(attacker).has("5,6")', context), true, 'enemy vision passes through hidden Stealth');
assert.equal(vm.runInContext('getValidMoves(attacker).some(move => move.row === 5 && move.col === 5)', context), true);
assert.equal(vm.runInContext('isValidPath(attacker, [{r:5,c:4},{r:5,c:5},{r:5,c:6}])', context), true);

vm.runInContext(`
  boards.area1[5][3].unit = null;
  attacker.col = 4;
  boards.area1[5][4].unit = attacker;
`, context);
assert.equal(vm.runInContext('isStealthHiddenFromPlayer(stealth, 2)', context), false, 'orthogonal adjacency reveals Stealth');
assert.equal(vm.runInContext('getUnitVisionCells(attacker).has("5,6")', context), false, 'revealed Stealth blocks vision');
vm.runInContext('boards.area1[5][4].unit = null; attacker.col = 3; boards.area1[5][3].unit = attacker', context);

vm.runInContext('maybeClearCamouflageAfterMove(stealth)', context);
assert.equal(vm.runInContext('stealth.stealthInvisible', context), false, 'movement cancels invisibility');
assert.equal(vm.runInContext('stealth.stealthStillTurns', context), 0);
vm.runInContext('updateStealthAtTurnEnd(1)', context);
assert.equal(vm.runInContext('stealth.stealthStillTurns', context), 0, 'moving turn does not count as stationary');
vm.runInContext('updateStealthAtTurnEnd(1); updateStealthAtTurnEnd(1); updateStealthAtTurnEnd(1)', context);
assert.equal(vm.runInContext('stealth.stealthInvisible', context), true);

vm.runInContext('executeMove(attacker, 5, 6)', context);
assert.equal(vm.runInContext('units.includes(stealth)', context), true, 'passing through leaves Stealth alive');
assert.equal(vm.runInContext('attacker.col', context), 6);
vm.runInContext('boards.area1[5][6].unit = null; attacker.col = 3; boards.area1[5][3].unit = attacker', context);
vm.runInContext('executeMove(attacker, 5, 5)', context);
assert.equal(vm.runInContext('units.includes(stealth)', context), false, 'stopping on hidden Stealth captures it');
assert.equal(vm.runInContext('boards.area1[5][5].unit === attacker', context), true);

console.log('Stealth timing, detection, vision, traversal, and overlap capture verified.');
