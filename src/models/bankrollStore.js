/**
 * bankrollStore.js
 * In-memory bankroll + bet tracking store.
 * In production, replace this with a real database (Supabase/Postgres).
 *
 * Schema:
 *   bankroll: { userId, balance, startingBalance, currency }
 *   bets: [{ id, userId, player, propType, line, direction, odds, stake, units, result, profit, placedAt, settledAt }]
 */

// Simple in-memory store — keyed by userId
const bankrolls = {};
const bets = {};

const DEFAULT_BANKROLL = 1000;

function getOrCreateBankroll(userId) {
  if (!bankrolls[userId]) {
    bankrolls[userId] = {
      userId,
      balance: DEFAULT_BANKROLL,
      startingBalance: DEFAULT_BANKROLL,
      currency: 'USD',
      createdAt: new Date().toISOString(),
    };
  }
  return bankrolls[userId];
}

function getUserBets(userId) {
  return bets[userId] || [];
}

/**
 * Record a new bet
 * @param {string} userId
 * @param {Object} betData - { player, propLabel, line, direction, odds, units, stake }
 */
function placeBet(userId, betData) {
  const bankroll = getOrCreateBankroll(userId);
  const betId = `bet_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const bet = {
    id: betId,
    userId,
    player: betData.player,
    propLabel: betData.propLabel,
    line: betData.line,
    direction: betData.direction || 'over',
    odds: betData.odds,
    units: betData.units || 1,
    stake: betData.stake || (bankroll.balance * 0.01 * (betData.units || 1)),
    result: 'pending',
    profit: null,
    placedAt: new Date().toISOString(),
    settledAt: null,
    gameId: betData.gameId || null,
    notes: betData.notes || '',
  };

  if (!bets[userId]) bets[userId] = [];
  bets[userId].push(bet);

  return bet;
}

/**
 * Settle a bet (win/loss/push)
 * @param {string} userId
 * @param {string} betId
 * @param {'win'|'loss'|'push'} result
 * @param {number} [actualValue] - what the player actually hit
 */
function settleBet(userId, betId, result, actualValue) {
  const userBets = bets[userId] || [];
  const bet = userBets.find(b => b.id === betId);
  if (!bet) return null;

  bet.result = result;
  bet.actualValue = actualValue || null;
  bet.settledAt = new Date().toISOString();

  const bankroll = getOrCreateBankroll(userId);

  if (result === 'win') {
    const payout = calculatePayout(bet.stake, bet.odds);
    bet.profit = payout - bet.stake;
    bankroll.balance += payout;
  } else if (result === 'loss') {
    bet.profit = -bet.stake;
    bankroll.balance -= bet.stake;
  } else if (result === 'push') {
    bet.profit = 0;
    // stake returned — no change
  }

  return bet;
}

/**
 * Get full stats for a user's bankroll
 */
function getBankrollStats(userId) {
  const bankroll = getOrCreateBankroll(userId);
  const userBets = getUserBets(userId);
  const settled = userBets.filter(b => b.result !== 'pending');
  const wins = settled.filter(b => b.result === 'win');
  const losses = settled.filter(b => b.result === 'loss');
  const pending = userBets.filter(b => b.result === 'pending');

  const totalProfit = settled.reduce((sum, b) => sum + (b.profit || 0), 0);
  const totalUnits = settled.reduce((sum, b) => {
    if (b.result === 'win') return sum + b.units;
    if (b.result === 'loss') return sum - b.units;
    return sum;
  }, 0);

  const roi = settled.length > 0
    ? (totalProfit / settled.reduce((sum, b) => sum + b.stake, 0)) * 100
    : 0;

  // Rolling hit rate over last 10 settled bets
  const last10 = settled.slice(-10);
  const l10Wins = last10.filter(b => b.result === 'win').length;

  return {
    bankroll,
    stats: {
      totalBets: userBets.length,
      settledBets: settled.length,
      pendingBets: pending.length,
      wins: wins.length,
      losses: losses.length,
      winRate: settled.length > 0 ? Math.round((wins.length / settled.length) * 100) : 0,
      l10WinRate: last10.length > 0 ? Math.round((l10Wins / last10.length) * 100) : 0,
      totalProfit: Math.round(totalProfit * 100) / 100,
      totalUnits: Math.round(totalUnits * 10) / 10,
      roi: Math.round(roi * 10) / 10,
      startingBalance: bankroll.startingBalance,
      currentBalance: Math.round(bankroll.balance * 100) / 100,
      profitLoss: Math.round((bankroll.balance - bankroll.startingBalance) * 100) / 100,
    },
    recentBets: userBets.slice(-20).reverse(),
  };
}

/**
 * Update starting bankroll balance
 */
function setBalance(userId, amount) {
  const bankroll = getOrCreateBankroll(userId);
  bankroll.balance = amount;
  bankroll.startingBalance = amount;
  return bankroll;
}

function calculatePayout(stake, americanOdds) {
  if (americanOdds > 0) {
    return stake + (stake * americanOdds / 100);
  } else {
    return stake + (stake * 100 / Math.abs(americanOdds));
  }
}

module.exports = {
  getOrCreateBankroll,
  getUserBets,
  placeBet,
  settleBet,
  getBankrollStats,
  setBalance,
};
