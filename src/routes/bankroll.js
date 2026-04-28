/**
 * routes/bankroll.js
 * GET  /api/bankroll           — get stats + recent bets
 * POST /api/bankroll/bet       — record a new bet
 * PUT  /api/bankroll/bet/:id   — settle a bet (win/loss/push)
 * PUT  /api/bankroll/balance   — set bankroll balance
 * GET  /api/bankroll/bets      — full bet history
 */

const express = require('express');
const router = express.Router();
const {
  getBankrollStats,
  placeBet,
  settleBet,
  setBalance,
  getUserBets,
} = require('../models/bankrollStore');

// For demo, userId comes from auth header or defaults to 'demo'
function getUserId(req) {
  return req.headers['x-user-id'] || 'demo';
}

// GET /api/bankroll
router.get('/', (req, res) => {
  const userId = getUserId(req);
  const data = getBankrollStats(userId);
  res.json(data);
});

// GET /api/bankroll/bets
router.get('/bets', (req, res) => {
  const userId = getUserId(req);
  const { status, limit = 50 } = req.query;
  let bets = getUserBets(userId);
  if (status) bets = bets.filter(b => b.result === status);
  bets = bets.slice(-parseInt(limit)).reverse();
  res.json({ count: bets.length, bets });
});

// POST /api/bankroll/bet
router.post('/bet', (req, res) => {
  const userId = getUserId(req);
  const { player, propLabel, line, direction, odds, units, stake, gameId, notes } = req.body;

  if (!player || !line || !odds) {
    return res.status(400).json({
      error: 'Required fields: player, line, odds'
    });
  }

  const bet = placeBet(userId, { player, propLabel, line, direction, odds, units, stake, gameId, notes });
  res.status(201).json({ message: 'Bet recorded', bet });
});

// PUT /api/bankroll/bet/:id
router.put('/bet/:id', (req, res) => {
  const userId = getUserId(req);
  const { id } = req.params;
  const { result, actualValue } = req.body;

  if (!['win', 'loss', 'push'].includes(result)) {
    return res.status(400).json({ error: 'result must be: win | loss | push' });
  }

  const bet = settleBet(userId, id, result, actualValue);
  if (!bet) return res.status(404).json({ error: 'Bet not found' });

  const stats = getBankrollStats(userId);
  res.json({ message: 'Bet settled', bet, updatedStats: stats.stats });
});

// PUT /api/bankroll/balance
router.put('/balance', (req, res) => {
  const userId = getUserId(req);
  const { amount } = req.body;

  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const bankroll = setBalance(userId, parseFloat(amount));
  res.json({ message: 'Balance updated', bankroll });
});

module.exports = router;
