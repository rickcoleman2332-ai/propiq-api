const express = require('express');
const router = express.Router();
const { getQuotaStatus } = require('../services/oddsApi');

// GET /health — basic liveness check
router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'PropIQ API',
    version: '1.0.0',
    sport: 'MLB',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
  });
});

// GET /health/quota — check Odds API quota
router.get('/quota', async (req, res, next) => {
  try {
    const quota = await getQuotaStatus();
    res.json({ status: 'ok', quota });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
