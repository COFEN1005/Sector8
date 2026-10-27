const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SECTOR8_SQLITE_PATH = ':memory:';
const { createSqliteStore } = require('../account-store');
const { getLevelPassLevels, findClaimableReward } = require('../level-pass');

const levels = getLevelPassLevels();
assert.equal(levels.length, 50);
assert.equal(levels[0].level, 1);
assert.equal(levels[49].level, 50);
assert.equal(getLevelPassLevels(75).length, 75);
assert.deepEqual(levels.filter(entry => entry.reward.status === 'active').map(entry => entry.level),
  [1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
assert.equal(getLevelPassLevels(75)[74].reward.key, 'koh_ticket_lv75');
assert.equal(findClaimableReward('koh_ticket_lv1').level, 1);
assert.equal(findClaimableReward('koh_ticket_lv10').level, 10);
assert.equal(findClaimableReward('koh_ticket_lv15').level, 15);
assert.equal(findClaimableReward('koh_ticket_lv50').level, 50);
assert.equal(findClaimableReward('signal_vanguard'), null);
assert.equal(findClaimableReward('not_in_catalog'), null);
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
assert.match(html, /id="level-pass-grid"[^>]*tabindex="0"/);
assert.match(html, /id="level-pass-current"/);
assert.match(css, /\.level-pass-grid\s*\{[^}]*grid-auto-flow:\s*column;[^}]*overflow-x:\s*auto;/);
assert.match(css, /\.workspace-screen\.level-pass-screen\s*\{[^}]*width:\s*min\(86rem, 100%\)/);

const store = createSqliteStore();
const registration = store.registerPlayer({ name: 'LevelPassTest', pin: '1234' });
assert.equal(registration.ok, true);
const playerId = registration.profile.id;
const firstReward = findClaimableReward('koh_ticket_lv1');
assert.equal(store.claimLevelPassReward(playerId, firstReward).ok, true);
assert.equal(store.claimLevelPassReward(playerId, firstReward).ok, true);
assert.equal(store.getLevelPassUnlocks(playerId).length, 1, 'duplicate claims stay idempotent');
assert.equal(store.claimLevelPassReward(playerId, { key: 'future', type: 'bgm', level: 50 }).error, 'level_locked');
assert.equal(store.getLevelPassUnlocks(playerId).length, 1);
const legacy = store.registerPlayer({ name: 'LegacyPass', pin: '1234' });
assert.equal(store.claimLevelPassReward(legacy.profile.id, {
  key: 'signal_vanguard', type: 'title', level: 1
}).ok, true);
assert.equal(store.claimLevelPassReward(legacy.profile.id, firstReward).ok, true);
assert.equal(store.getLevelPassUnlocks(legacy.profile.id).length, 2, 'legacy title does not block the new Lv1 ticket');
store.db.close();

console.log('Level pass catalog, unlock persistence, and duplicate claims verified.');
