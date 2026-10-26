const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert.match(html, /id="tutorial-hud"/);
assert.match(html, /id="tutorial-next"/);
assert.doesNotMatch(html, /tutorial\.js\?/);
const context = vm.createContext({
  console,
  window: { location: { search: '' }, addEventListener() {} },
  document: { addEventListener() {}, getElementById() { return null; } },
  localStorage: { getItem() { return null; } },
  URLSearchParams,
  setTimeout,
  clearTimeout
});
vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), context);
context.preset = JSON.parse(fs.readFileSync(path.join(root, 'sector8-map1.json'), 'utf8'));
vm.runInContext('p2Ability = "戦姫"; fixedMapPreset = normalizeFixedMapPreset(preset); initializeBoards(); initializeTutorialUnits(); calculateVisibility();', context);

const initial = JSON.parse(vm.runInContext(`JSON.stringify({
  units: units.map(unit => ({ id: unit.id, map: unit.map, row: unit.row, col: unit.col })),
  otsuMoves: getValidMoves(units.find(unit => unit.id === 'tutorial_otsu'), { hideUnseenEnemies: true }),
  teiMoves: getValidMoves(units.find(unit => unit.id === 'tutorial_tei'), { hideUnseenEnemies: true })
})`, context));
assert.equal(initial.units.filter(unit => unit.id === 'tutorial_p2_core').length, 1);
assert.ok(initial.units.some(unit => unit.id === 'tutorial_enemy_koh'));
assert.ok(initial.units.every(unit => unit.id.includes('core') || unit.map === 'area3'));
assert.ok(initial.otsuMoves.some(move => move.row === 2 && move.col === 6 && move.type === 'move'));
assert.ok(initial.teiMoves.some(move => move.row === 1 && move.col === 4 && move.type === 'attack'));

vm.runInContext(`tutorialMode = true; tutorialStep = 0; addConsoleLog = () => {}; playMoveSfx = () => {}; completeUnitAction = () => {}; advanceTutorialAfterSelection(units.find(unit => unit.id === 'tutorial_otsu'));`, context);
assert.equal(vm.runInContext('tutorialStep', context), 1);
vm.runInContext(`executeMove(units.find(unit => unit.id === 'tutorial_otsu'), 2, 6);`, context);
assert.equal(vm.runInContext('tutorialStep', context), 2);
vm.runInContext(`advanceTutorialAfterSelection(units.find(unit => unit.id === 'tutorial_tei'));`, context);
assert.equal(vm.runInContext('tutorialStep', context), 3);
vm.runInContext(`executeMove(units.find(unit => unit.id === 'tutorial_tei'), 1, 4);`, context);
assert.equal(vm.runInContext('tutorialStep', context), 4);
assert.equal(vm.runInContext('units.some(unit => unit.id === "tutorial_enemy_koh")', context), false);
const droppedFlag = JSON.parse(vm.runInContext('JSON.stringify(militaryFlags.find(flag => flag.map === "area3" && flag.row === 1 && flag.col === 4))', context));
assert.equal(droppedFlag.player, 2, 'defeating the Koh drops its real military flag');
assert.equal(droppedFlag.ability, '戦姫');
assert.match(vm.runInContext('TUTORIAL_LESSONS[4].copy', context), /軍旗.*7回.*情報崩壊.*15/);
assert.match(vm.runInContext('TUTORIAL_LESSONS[5].copy', context), /千里眼.*暗殺者.*戦姫.*監視.*弓兵/);
vm.runInContext('countInformationCollapseTurn(1)', context);
assert.equal(vm.runInContext('informationCollapseTurns[1]', context), 1, 'ending a turn without area 2 control adds one collapse');
vm.runInContext('advanceTutorialBriefing(); advanceTutorialBriefing(); calculateVisibility(); advanceTutorialAfterSelection(units.find(unit => unit.id === "tutorial_otsu"));', context);
assert.equal(vm.runInContext('tutorialStep', context), 7);
const coreAttack = JSON.parse(vm.runInContext(`JSON.stringify(getValidMoves(
  units.find(unit => unit.id === 'tutorial_otsu'), { hideUnseenEnemies: true }
).find(move => move.row === 0 && move.col === 6))`, context));
assert.equal(coreAttack.type, 'attack', 'real movement and visibility rules allow attacking the core');

vm.runInContext(`tutorialWinner = null; triggerWin = winner => { tutorialWinner = winner; isGameOver = true; }; executeMove(units.find(unit => unit.id === 'tutorial_otsu'), 0, 6);`, context);
assert.equal(vm.runInContext('tutorialWinner', context), 1, 'capturing the real core triggers victory');
assert.equal(vm.runInContext('boards.area3[0][4].unit === null && boards.area3[0][5].unit === null && boards.area3[0][6].unit === null', context), true);
assert.equal(vm.runInContext('currentMatchRecord === null && currentMatchReplay === null', context), true, 'training creates no match record or replay');

console.log('Tutorial movement, military flag, rule briefings, and core-victory capture verified.');
