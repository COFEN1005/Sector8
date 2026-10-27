const assert = require('node:assert/strict');

process.env.SECTOR8_SQLITE_PATH = ':memory:';
const { createSqliteStore } = require('../account-store');
const { getLevelPassLevels, findClaimableReward } = require('../level-pass');

const levels = getLevelPassLevels();
assert.equal(levels.length, 50);
assert.equal(levels[0].level, 1);
assert.equal(levels[49].level, 50);
assert.equal(getLevelPassLevels(75).length, 75);
assert.equal(findClaimableReward('signal_vanguard').status, 'active');
assert.equal(findClaimableReward('koh_ticket_lv10').level, 10);
assert.equal(findClaimableReward('not_in_catalog'), null);

const store = createSqliteStore();
const registration = store.registerPlayer({ name: 'LevelPassTest', pin: '1234' });
assert.equal(registration.ok, true);
const playerId = registration.profile.id;
const firstReward = findClaimableReward('signal_vanguard');
assert.equal(store.claimLevelPassReward(playerId, firstReward).ok, true);
assert.equal(store.claimLevelPassReward(playerId, firstReward).ok, true);
assert.equal(store.getLevelPassUnlocks(playerId).length, 1, 'duplicate claims stay idempotent');
assert.equal(store.claimLevelPassReward(playerId, { key: 'future', type: 'bgm', level: 50 }).error, 'level_locked');
assert.equal(store.getLevelPassUnlocks(playerId).length, 1);
store.db.close();

console.log('Level pass catalog, unlock persistence, and duplicate claims verified.');
