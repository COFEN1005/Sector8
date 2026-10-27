const assert = require('node:assert/strict');

process.env.ACCOUNT_BACKEND = 'sqlite';
process.env.SECTOR8_SQLITE_PATH = ':memory:';
const { createSqliteStore } = require('../account-store');
const { findClaimableReward } = require('../level-pass');
const { findPurchasableProduct } = require('../shop-catalog');
const { canSelectKohAbility } = require('../server');

(async () => {
  const store = createSqliteStore();
  const registration = store.registerPlayer({ name: 'AngelAuth', pin: '1234' });
  const info = { authToken: registration.token };
  assert.equal(await canSelectKohAbility(null, '千里眼', store), true);
  assert.equal(await canSelectKohAbility(null, '天使', store), false);
  assert.equal(await canSelectKohAbility(info, '隠密', store), false);
  assert.equal(await canSelectKohAbility(info, '偽物', store), false);
  assert.equal(await canSelectKohAbility(info, '天使', store), false);
  store.db.prepare('UPDATE players SET level = 5 WHERE id = ?').run(registration.profile.id);
  assert.equal(store.claimLevelPassReward(registration.profile.id, findClaimableReward('koh_ticket_lv5')).ok, true);
  assert.equal(store.redeemShopProduct(registration.profile.id, findPurchasableProduct('koh_angel')).ok, true);
  assert.equal(await canSelectKohAbility(info, '天使', store), true);
  store.db.prepare('UPDATE players SET level = 10 WHERE id = ?').run(registration.profile.id);
  assert.equal(store.claimLevelPassReward(registration.profile.id, findClaimableReward('koh_ticket_lv10')).ok, true);
  assert.equal(store.redeemShopProduct(registration.profile.id, findPurchasableProduct('koh_stealth')).ok, true);
  assert.equal(await canSelectKohAbility(info, '隠密', store), true);
  const decoyRegistration = store.registerPlayer({ name: 'DecoyAuth', pin: '1234' });
  const decoyInfo = { authToken: decoyRegistration.token };
  store.db.prepare('UPDATE players SET level = 5 WHERE id = ?').run(decoyRegistration.profile.id);
  assert.equal(store.claimLevelPassReward(decoyRegistration.profile.id, findClaimableReward('koh_ticket_lv5')).ok, true);
  assert.equal(store.redeemShopProduct(decoyRegistration.profile.id, findPurchasableProduct('koh_decoy')).ok, true);
  assert.equal(await canSelectKohAbility(decoyInfo, '偽物', store), true);
  assert.equal(await canSelectKohAbility(info, 'not_a_koh', store), false);
  store.db.close();
  console.log('Online Koh selection requires recorded Angel, Stealth, and Decoy purchases.');
})().catch(error => { console.error(error); process.exitCode = 1; });
