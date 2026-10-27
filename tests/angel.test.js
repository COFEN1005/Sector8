const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
  tutorialMode = true;
  p1Ability = '天使';
  p2Ability = '監視';
  initializeBoards();
  const angel = new Unit('angel', 'koh', 1, 'area1', 5, 5);
  const ally = new Unit('ally', 'otsu', 1, 'area1', 5, 6);
  const elsewhere = new Unit('elsewhere', 'hei', 1, 'area2', 5, 5);
  const enemy = new Unit('enemy', 'hei', 2, 'area1', 5, 7);
  addUnitToBoard(angel, 'area1', 5, 5);
  addUnitToBoard(ally, 'area1', 5, 6);
  addUnitToBoard(elsewhere, 'area2', 5, 5);
  addUnitToBoard(enemy, 'area1', 5, 7);
  addConsoleLog = () => {};
  playMoveSfx = () => {};
  recordMatchReplayEvent = () => {};
  sendOnlineMessage = () => {};
  consumeTurnWithoutMarkingActed = () => {};
  actedUnitIds.add('ally');
`, context);

assert.equal(vm.runInContext('angel.getMovementRange()', context), 2);
assert.equal(vm.runInContext('angel.getVisionRange()', context), 3);
assert.equal(vm.runInContext('getAngelBlessingTargets(angel).length', context), 2);
vm.runInContext('executeAbility(angel, 5, 7)', context);
assert.equal(vm.runInContext('getAngelBlessingCooldownRemaining(1)', context), 0, 'enemy is not a blessing target');
vm.runInContext('executeAbility(angel, 5, 6)', context);
assert.equal(vm.runInContext('actedUnitIds.has("ally")', context), false);
assert.equal(vm.runInContext('getAngelBlessingCooldownRemaining(1)', context), 10);
vm.runInContext('captureUnit(enemy, 1)', context);
assert.equal(vm.runInContext('getAngelBlessingCooldownRemaining(1)', context), 8);
vm.runInContext('angelBlessingCooldownByPlayer[1] = 1; captureUnit(new Unit("enemy2", "hei", 2, "area1", 4, 4), 1)', context);
assert.equal(vm.runInContext('getAngelBlessingCooldownRemaining(1)', context), 0, 'Quick does not underflow');
assert.equal(vm.runInContext('getAllAbilityOptions().includes("天使")', context), false);
vm.runInContext('ownedKohAbilities.add("天使")', context);
assert.equal(vm.runInContext('getAllAbilityOptions().includes("天使")', context), true);

console.log('Angel movement, blessing targets, cooldown, Quick, and entitlement verified.');
