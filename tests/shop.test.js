const assert = require('node:assert/strict');

process.env.SECTOR8_SQLITE_PATH = ':memory:';
const { createSqliteStore } = require('../account-store');
const { findClaimableReward } = require('../level-pass');
const { KOH_TICKET, getShopProducts, findPurchasableProduct, calculateTicketBalance } = require('../shop-catalog');

assert.equal(findPurchasableProduct('not_available'), null);
assert.equal(getShopProducts()[0].status, 'planned');
assert.equal(findClaimableReward('koh_ticket_lv5').type, KOH_TICKET);

const store = createSqliteStore();
const registration = store.registerPlayer({ name: 'ShopTest', pin: '1234' });
assert.equal(registration.ok, true);
const playerId = registration.profile.id;
const ticketReward = findClaimableReward('koh_ticket_lv5');
assert.equal(store.claimLevelPassReward(playerId, ticketReward).error, 'level_locked');
store.db.prepare('UPDATE players SET level = 5 WHERE id = ?').run(playerId);
assert.equal(store.claimLevelPassReward(playerId, ticketReward).ok, true);
assert.equal(store.claimLevelPassReward(playerId, ticketReward).ok, true);
assert.equal(calculateTicketBalance(store.getLevelPassUnlocks(playerId), store.getShopPurchases(playerId)), 1);

const futureKoh = {
  key: 'future_koh_test', type: 'koh', itemKey: 'future_koh_test', currency: KOH_TICKET, price: 1
};
const first = store.redeemShopProduct(playerId, futureKoh);
assert.equal(first.ok, true);
assert.equal(first.remaining, 0);
assert.equal(store.redeemShopProduct(playerId, futureKoh).error, 'already_owned');
assert.equal(store.redeemShopProduct(playerId, { ...futureKoh, key: 'alias' }).error, 'already_owned');
assert.equal(store.redeemShopProduct(playerId, { ...futureKoh, key: 'another', itemKey: 'another' }).error, 'insufficient_tickets');
assert.equal(store.getShopPurchases(playerId).length, 1);
assert.equal(calculateTicketBalance(store.getLevelPassUnlocks(playerId), store.getShopPurchases(playerId)), 0);
assert.equal(store.redeemShopProduct(-1, futureKoh).error, 'not_found');
store.db.close();

console.log('Shop tickets, single-use redemption, duplicate protection, and balances verified.');
