const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert.match(html, /id="tutorial-hud"/);
assert.match(html, /id="tutorial-next"/);
assert.match(html, /id="tutorial-scene-label"/);
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
assert.equal(vm.runInContext('TUTORIAL_LESSONS.length', context), 13);
assert.equal(vm.runInContext('TUTORIAL_SCENE_NAMES.length', context), 5);
context.preset = JSON.parse(fs.readFileSync(path.join(root, 'sector8-map1.json'), 'utf8'));
vm.runInContext('tutorialMode = true; p1Ability = "千里眼"; p2Ability = "戦姫"; fixedMapPreset = normalizeFixedMapPreset(preset); initializeBoards(); initializeTutorialUnits(); calculateVisibility();', context);

const initial = JSON.parse(vm.runInContext(`JSON.stringify({
  units: units.map(unit => ({ id: unit.id, map: unit.map, row: unit.row, col: unit.col })),
  otsuMoves: getValidMoves(units.find(unit => unit.id === 'tutorial_otsu'), { hideUnseenEnemies: true }),
  teiMoves: getValidMoves(units.find(unit => unit.id === 'tutorial_tei'), { hideUnseenEnemies: true })
})`, context));
assert.equal(initial.units.filter(unit => unit.id === 'tutorial_p2_core').length, 1);
assert.ok(initial.units.some(unit => unit.id === 'tutorial_enemy_tei'));
assert.ok(initial.units.every(unit => unit.id.includes('core') || unit.map === 'area3'));
assert.ok(initial.otsuMoves.some(move => move.row === 2 && move.col === 6 && move.type === 'move'));
assert.ok(initial.teiMoves.some(move => move.row === 1 && move.col === 4 && move.type === 'attack'));

vm.runInContext(`tutorialStep = 0; addConsoleLog = () => {}; playMoveSfx = () => {}; completeUnitAction = () => {}; advanceTutorialAfterSelection(units.find(unit => unit.id === 'tutorial_otsu'));`, context);
assert.equal(vm.runInContext('tutorialStep', context), 1);
vm.runInContext(`executeMove(units.find(unit => unit.id === 'tutorial_otsu'), 2, 6);`, context);
assert.equal(vm.runInContext('tutorialStep', context), 2);
vm.runInContext(`advanceTutorialAfterSelection(units.find(unit => unit.id === 'tutorial_tei'));`, context);
assert.equal(vm.runInContext('tutorialStep', context), 3);
vm.runInContext(`executeMove(units.find(unit => unit.id === 'tutorial_tei'), 1, 4);`, context);
assert.equal(vm.runInContext('tutorialStep', context), 4);
assert.equal(vm.runInContext('units.some(unit => unit.id === "tutorial_enemy_tei")', context), false);
assert.equal(vm.runInContext('militaryFlags.length', context), 0, 'defeating a Tei does not drop a flag');

vm.runInContext(`cancelSelection = () => {}; switchActiveMap = map => { activeMap = map; }; updateUI = () => {}; renderTutorialHud = () => {}; advanceTutorialBriefing();`, context);
assert.equal(vm.runInContext('tutorialStep', context), 5);
assert.equal(vm.runInContext('activeMap', context), 'area1');
const friendlyFlag = JSON.parse(vm.runInContext('JSON.stringify(militaryFlags[0])', context));
assert.equal(friendlyFlag.player, 1, 'the flag scene uses a blue flag');
assert.equal(friendlyFlag.map, 'area1');
assert.equal(vm.runInContext('p1KohDestroyed', context), true);
const flagMoves = JSON.parse(vm.runInContext('JSON.stringify(getValidMoves(units.find(unit => unit.id === "tutorial_tei"), { hideUnseenEnemies: true }))', context));
assert.ok(flagMoves.some(move => move.row === 8 && move.col === 4 && move.type === 'move'));
vm.runInContext('advanceTutorialAfterSelection(units.find(unit => unit.id === "tutorial_tei"))', context);
vm.runInContext('executeMove(units.find(unit => unit.id === "tutorial_tei"), 8, 4)', context);
assert.equal(vm.runInContext('tutorialStep', context), 7);
assert.equal(vm.runInContext('units.find(unit => unit.id === "tutorial_tei").carryingFlagPlayer', context), 1);
assert.equal(vm.runInContext('militaryFlags.length', context), 0);
assert.match(vm.runInContext('TUTORIAL_LESSONS[6].copy', context), /敵の軍旗は拾えません/);
vm.runInContext('clearFlagCarrier(units.find(unit => unit.id === "tutorial_tei")); dropMilitaryFlag(2, "area1", 8, 4, "戦姫", true)', context);
assert.equal(vm.runInContext('tryPickupMilitaryFlag(units.find(unit => unit.id === "tutorial_tei"))', context), false, 'a blue unit cannot pick up a red flag');

vm.runInContext('advanceTutorialBriefing()', context);
assert.equal(vm.runInContext('tutorialStep', context), 8);
assert.equal(vm.runInContext('activeMap', context), 'area2');
assert.equal(vm.runInContext('hasArea2ControlUnit(1)', context), false, 'a scout alone cannot stop collapse');
vm.runInContext('endTurn = () => { countInformationCollapseTurn(1); }; advanceTutorialBriefing()', context);
assert.equal(vm.runInContext('tutorialStep', context), 9);
assert.equal(vm.runInContext('informationCollapseTurns[1]', context), 1);

vm.runInContext('advanceTutorialBriefing()', context);
assert.equal(vm.runInContext('tutorialStep', context), 10);
assert.equal(vm.runInContext('units.some(unit => unit.id === "tutorial_koh")', context), true);
assert.match(vm.runInContext('TUTORIAL_LESSONS[10].copy', context), /千里眼[\s\S]*暗殺者[\s\S]*戦姫[\s\S]*監視[\s\S]*弓兵/);
vm.runInContext('advanceTutorialBriefing()', context);
assert.equal(vm.runInContext('tutorialStep', context), 11);
assert.equal(vm.runInContext('activeMap', context), 'area3');
vm.runInContext('advanceTutorialAfterSelection(units.find(unit => unit.id === "tutorial_otsu"))', context);
assert.equal(vm.runInContext('tutorialStep', context), 12);
const coreAttack = JSON.parse(vm.runInContext(`JSON.stringify(getValidMoves(
  units.find(unit => unit.id === 'tutorial_otsu'), { hideUnseenEnemies: true }
).find(move => move.row === 0 && move.col === 6))`, context));
assert.equal(coreAttack.type, 'attack', 'real movement and visibility rules allow attacking the core');

vm.runInContext(`tutorialWinner = null; triggerWin = winner => { tutorialWinner = winner; isGameOver = true; }; executeMove(units.find(unit => unit.id === 'tutorial_otsu'), 0, 6);`, context);
assert.equal(vm.runInContext('tutorialWinner', context), 1, 'capturing the real core triggers victory');
assert.equal(vm.runInContext('boards.area3[0][4].unit === null && boards.area3[0][5].unit === null && boards.area3[0][6].unit === null', context), true);
assert.equal(vm.runInContext('currentMatchRecord === null && currentMatchReplay === null', context), true, 'training creates no match record or replay');

console.log('Tutorial scenes, friendly flag pickup, collapse, Koh types, and core victory verified.');
