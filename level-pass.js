const INITIAL_LEVEL_PASS_MAX = 50;

// Add reward definitions here without changing the progression or claim schema.
const ACTIVE_REWARDS = Object.freeze({
  1: Object.freeze({
    key: 'signal_vanguard',
    type: 'title',
    name: '先行信号',
    description: 'レベルパス開始記念の称号。装備機能は今後追加予定。'
  })
});

const MILESTONE_TYPES = Object.freeze({
  5: 'koh', 10: 'bgm', 15: 'bonus', 20: 'koh', 25: 'bgm',
  30: 'bonus', 35: 'koh', 40: 'bgm', 45: 'bonus', 50: 'koh'
});

const PLACEHOLDER_LABELS = Object.freeze({
  koh: '甲アンロック枠',
  bgm: 'BGMアンロック枠',
  bonus: '報酬枠',
  standard: '報酬枠'
});

function getLevelPassReward(level) {
  const active = ACTIVE_REWARDS[level];
  if (active) return { ...active, level, status: 'active' };
  const type = MILESTONE_TYPES[level] || 'standard';
  return { key: null, type, name: PLACEHOLDER_LABELS[type], level, status: 'planned' };
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
