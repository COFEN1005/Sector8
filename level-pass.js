const INITIAL_LEVEL_PASS_MAX = 50;

function getLevelPassReward(level) {
  if (level === 1 || level % 5 === 0) {
    return {
      key: `koh_ticket_lv${level}`,
      type: 'koh_ticket',
      name: '甲引換券 x1',
      description: 'ショップで新たな甲との交換に使用できます。',
      level,
      status: 'active'
    };
  }
  return { key: null, type: 'standard', name: '報酬枠', level, status: 'planned' };
}

function getLevelPassLevels(maxLevel = INITIAL_LEVEL_PASS_MAX) {
  const limit = Math.max(1, Math.trunc(Number(maxLevel) || INITIAL_LEVEL_PASS_MAX));
  return Array.from({ length: limit }, (_, index) => {
    const level = index + 1;
    return { level, reward: getLevelPassReward(level) };
  });
}

function findClaimableReward(key) {
  return getLevelPassLevels().map(entry => entry.reward)
    .find(reward => reward.status === 'active' && reward.key === key) || null;
}

module.exports = { INITIAL_LEVEL_PASS_MAX, getLevelPassLevels, findClaimableReward };
