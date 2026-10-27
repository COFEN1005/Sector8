const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
assert.match(html, /data-ability="偽物"/);
assert.match(html, /SKILL <span>デコイ<\/span>/);

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
  vsAI = false;
  p1Ability = '偽物';
  initializeBoards();
  const koh = new Unit('koh', 'koh', 1, 'area1', 5, 5);
  addUnitToBoard(koh, 'area1', 5, 5);
  addConsoleLog = () => {};
  playMoveSfx = () => {};
  recordMatchReplayEvent = () => {};
  sendOnlineMessage = () => {};
  cancelSelection = () => {};
  renderBoard = () => {};
  updateUI = () => {};
  showTurnBanner = () => {};
`, context);

assert.equal(vm.runInContext('koh.getMovementRange()', context), 3);
assert.equal(vm.runInContext('koh.getVisionRange()', context), 3);
assert.equal(vm.runInContext('getAllAbilityOptions().includes("偽物")', context), false);
vm.runInContext('ownedKohAbilities.add("偽物")', context);
assert.equal(vm.runInContext('getAllAbilityOptions().includes("偽物")', context), true);
assert.equal(vm.runInContext('getDecoyPlacementTargets(koh).some(target => target.row === 5 && target.col === 6)', context), true);
assert.equal(vm.runInContext('getDecoyPlacementTargets(koh).some(target => target.row === 5 && target.col === 9)', context), false);
vm.runInContext('executeAbility(koh, 5, 9)', context);
assert.equal(vm.runInContext('units.filter(unit => unit.type === "decoy").length', context), 0, 'out-of-range placement is rejected');

vm.runInContext('executeAbility(koh, 5, 6)', context);
assert.equal(vm.runInContext('units.filter(unit => unit.type === "decoy").length', context), 1);
assert.equal(vm.runInContext('getDecoyCooldownRemaining(1)', context), 6);
assert.equal(vm.runInContext('actionsThisTurn', context), 1, 'skill uses one action');
assert.equal(vm.runInContext('actedUnitIds.has(koh.id)', context), false, 'skill does not mark Koh acted');
assert.equal(vm.runInContext('getUnitVisionCells(boards.area1[5][6].unit).size', context), 0);
assert.equal(vm.runInContext('getValidMoves(boards.area1[5][6].unit).length', context), 0);
assert.equal(vm.runInContext('boards.area1[5][6].unit.symbol === koh.symbol', context), true);
assert.equal(vm.runInContext('getUnitInspectionProfile(boards.area1[5][6].unit).getMovementRange()', context), 3, 'inspection matches the real Koh');
assert.equal(vm.runInContext('getDecoyPlacementTargets(koh).some(target => target.row === 5 && target.col === 6)', context), false, 'occupied cells cannot be targeted');
assert.equal(vm.runInContext('serializeReplaySnapshot().units.some(unit => unit.type === "decoy" && unit.decoyOrder === 1)', context), true);
vm.runInContext('executeAbility(koh, 6, 5)', context);
assert.equal(vm.runInContext('units.filter(unit => unit.type === "decoy").length', context), 1, 'cooldown blocks another placement');
vm.runInContext(`
  tutorialMode = false;
  countInformationCollapseTurn = () => false;
  recordMatchReplaySnapshot = () => {};
  beginPlayerTurn = () => {};
  resetDrawRequests = () => {};
  showTurnBanner = () => {};
  hasAvailableActionUnit = () => true;
  endTurn();
`, context);
assert.equal(vm.runInContext('getDecoyCooldownRemaining(1)', context), 5, 'cooldown ticks at the owner turn end');
vm.runInContext('endTurn()', context);
assert.equal(vm.runInContext('getDecoyCooldownRemaining(1)', context), 5, 'opponent turn does not reduce cooldown');

vm.runInContext('decoyCooldownByPlayer[1] = 0; actionsThisTurn = 0; executeAbility(koh, 6, 5)', context);
assert.equal(vm.runInContext('units.filter(unit => unit.type === "decoy").length', context), 2);
vm.runInContext('decoyCooldownByPlayer[1] = 0; actionsThisTurn = 0; executeAbility(koh, 5, 4)', context);
assert.equal(vm.runInContext('units.filter(unit => unit.type === "decoy").length', context), 2);
assert.equal(vm.runInContext('boards.area1[5][6].unit', context), null, 'third placement removes the oldest');
assert.equal(vm.runInContext('boards.area1[6][5].unit.type', context), 'decoy');
assert.equal(vm.runInContext('boards.area1[5][4].unit.type', context), 'decoy');

vm.runInContext('const decoy = boards.area1[6][5].unit; captureUnit(decoy, 2)', context);
assert.equal(vm.runInContext('getPlayerKillCount(2)', context), 0, 'destroying a decoy does not count as a kill');
assert.equal(vm.runInContext('units.filter(unit => unit.type === "decoy").length', context), 1);

console.log('Decoy placement, capacity, action use, cooldown, visibility, and capture verified.');
