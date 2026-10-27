const KOH_TICKET = 'koh_ticket';

// Existing Koh stay free; new Koh are unlocked through ticket redemption.
const ACTIVE_PRODUCTS = Object.freeze([
  Object.freeze({
    key: 'koh_angel', type: 'koh', itemKey: '天使', name: '天使',
    description: '菱形移動2・視界3。クイックで祝福のCTを短縮し、味方を再行動可能にする。',
    currency: KOH_TICKET, price: 1
  }),
  Object.freeze({
    key: 'koh_stealth', type: 'koh', itemKey: '隠密', name: '隠密',
    description: '直線移動3・菱形視界3。3ターン静止すると透明化し、敵の視界と進路を通す。',
    currency: KOH_TICKET, price: 1
  })
]);

const PLANNED_PRODUCTS = Object.freeze([]);

function getShopProducts() {
  return [
    ...ACTIVE_PRODUCTS.map(product => ({ ...product, status: 'active' })),
    ...PLANNED_PRODUCTS.map(product => ({ ...product }))
  ];
}

function findPurchasableProduct(key) {
  return ACTIVE_PRODUCTS.find(product => product.key === key) || null;
}

function calculateTicketBalance(unlocks, purchases) {
  const earned = unlocks.filter(unlock => unlock.reward_type === KOH_TICKET).length;
  const spent = purchases.reduce((total, purchase) =>
    total + (purchase.currency_type === KOH_TICKET ? Number(purchase.price) || 0 : 0), 0);
  return Math.max(0, earned - spent);
}

module.exports = { KOH_TICKET, getShopProducts, findPurchasableProduct, calculateTicketBalance };
