const KOH_TICKET = 'koh_ticket';

// New products go here after their game behavior is implemented. Existing Koh stay free.
const ACTIVE_PRODUCTS = Object.freeze([]);

const PLANNED_PRODUCTS = Object.freeze([
  Object.freeze({
    key: null,
    type: 'koh',
    itemKey: null,
    name: '新たな甲',
    description: '新しい甲が追加されたら、甲引換券で交換できます。',
    currency: KOH_TICKET,
    price: 1,
    status: 'planned'
  })
]);

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
