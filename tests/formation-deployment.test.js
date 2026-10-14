const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const context = vm.createContext({
  console,
  window: { location: { search: '' }, addEventListener() {} },
  document: { addEventListener() {} },
  localStorage: { getItem() { return null; } },
  URLSearchParams,
  setTimeout,
  clearTimeout
});
vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), context);

for (let stage = 1; stage <= 6; stage++) {
  const preset = JSON.parse(fs.readFileSync(path.join(root, `sector8-map${stage}.json`), 'utf8'));
  const homeCells = [];
  const frontCells = [];
  for (let row = 0; row < 11; row++) {
    for (let col = 0; col < 11; col++) {
      if (!preset.maps.area1.cells[row][col].terrain) homeCells.push({ row, col });
      if (row >= 8 && !preset.maps.area2.cells[row][col].terrain) frontCells.push({ row, col });
    }
  }
  assert.ok(homeCells.length >= 9 && frontCells.length >= 7, `stage ${stage} has enough deployment cells`);
  const formation = {
    area1: ['otsu', 'hei', 'tei', 'tei', 'hei', 'tei', 'tei', 'hei', 'otsu']
      .map((type, index) => ({ id: `home_${index}`, type, ...homeCells[index] })),
    area2: [
      ['scout_1', 'scout'], ['koh', 'koh'], ['front_hei_1', 'hei'],
      ['front_tei_1', 'tei'], ['front_hei_2', 'hei'],
      ['front_tei_2', 'tei'], ['scout_2', 'scout']
    ].map(([id, type], index) => ({ id, type, ...frontCells[index] }))
  };

  context.preset = preset;
  context.formation = formation;
  vm.runInContext('fixedMapPreset = normalizeFixedMapPreset(preset); initializeBoards(); units = []; placePlayerFormation(1, formation); placePlayerFormation(2, formation);', context);
  const placed = JSON.parse(JSON.stringify(vm.runInContext(
    'units.map(unit => ({ id: unit.id, map: unit.map, row: unit.row, col: unit.col }))', context
  )));
  assert.equal(placed.length, 32, `stage ${stage} places every unit`);
  for (const entry of [...formation.area1, ...formation.area2]) {
    const blue = placed.find(unit => unit.id === `p1_${entry.id}`);
    const red = placed.find(unit => unit.id === `p2_${entry.id}`);
    const isHome = formation.area1.includes(entry);
    assert.deepEqual(blue, {
      id: `p1_${entry.id}`, map: isHome ? 'area1' : 'area2', row: entry.row, col: entry.col
    }, `stage ${stage} blue ${entry.id}`);
    assert.deepEqual(red, {
      id: `p2_${entry.id}`, map: isHome ? 'area3' : 'area2', row: 10 - entry.row, col: 10 - entry.col
    }, `stage ${stage} red ${entry.id}`);
  }
}

console.log('All six stages preserve both players\' saved formations.');
