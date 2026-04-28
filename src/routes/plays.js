/**
 * routes/plays.js
 * GET /api/plays — today's analyzed plays ranked by model score
 * GET /api/plays/:propId — detailed analysis for a single prop
 *
 * This is the core endpoint. It:
 *  1. Fetches today's props from The Odds API
 *  2. Attaches mock/real stats data per player
 *  3. Runs each prop through the 10-gate engine
 *  4. Returns only confirmed plays, ranked by score
 *
 * NOTE: statsData and matchupData are currently using a stub enrichment
 * function. Plug in your real stats source (Baseball Reference API,
 * MLB Stats API, or a scraper) in the enrichStats() function below.
 */

const express = require('express');
const router = express.Router();
const NodeCache = require('node-cache');

const { getAllPropsForMarket, PROP_MARKETS } = require('../services/oddsApi');
const { parsePropsFromEvents, isPitcherProp } = require('../services/propsParser');
const { analyzeProp, analyzeAll } = require('../services/gateEngine');
const { enrichAllProps } = require('../services/statsEnricher');

const analysisCache = new NodeCache();

// Default markets to analyze on the full plays endpoint
const DEFAULT_MARKETS = [
  'pitcher_strikeouts',
  'batter_total_bases',
  'batter_hits',
];

// GET /api/plays — full slate analysis
router.get('/', async (req, res, next) => {
  try {
    const {
      market,
      type,        // 'pitcher' | 'hitter'
      verdict,     // 'Strong Play' | 'Lean'
      minScore,
      limit = 20,
    } = req.query;

    const ttl = parseInt(process.env.ANALYSIS_CACHE_TTL) || 300;
    const cacheKey = `plays_${market || type || 'default'}`;

    // Check cache
    const cached = analysisCache.get(cacheKey);
    if (cached) {
      return res.json({ ...cached, fromCache: true });
    }

    // Determine markets
    let marketsToRun = [];
    if (market && PROP_MARKETS[market]) {
      marketsToRun = [market];
    } else if (type === 'pitcher') {
      marketsToRun = Object.keys(PROP_MARKETS).filter(isPitcherProp);
    } else if (type === 'hitter') {
      marketsToRun = Object.keys(PROP_MARKETS).filter(m => !isPitcherProp(m));
    } else {
      marketsToRun = DEFAULT_MARKETS;
    }

    // Fetch + parse all props
    const allProps = [];
    for (const mkt of marketsToRun) {
      try {
        const events = await getAllPropsForMarket(mkt);
        const props = parsePropsFromEvents(events, mkt);
        allProps.push(...props);
      } catch (err) {
        console.warn(`[Plays] Skipping market ${mkt}: ${err.message}`);
      }
    }

    if (allProps.length === 0) {
      return res.json({
        count: 0,
        plays: [],
        message: 'No props available for this slate. Check back closer to game time.',
        fetchedAt: new Date().toISOString(),
      });
    }

    // Enrich with real MLB stats + run gate analysis
    const propsWithData = await enrichAllProps(allProps);

    // Run gate analysis — analyzeAll returns only isPlay=true, sorted by score
    let plays = analyzeAll(propsWithData);

    // Apply filters
    if (verdict) {
      plays = plays.filter(p => p.verdict === verdict);
    }
    if (minScore) {
      plays = plays.filter(p => p.modelScore >= parseFloat(minScore));
    }

    // Limit
    plays = plays.slice(0, parseInt(limit));

    const response = {
      count: plays.length,
      totalAnalyzed: allProps.length,
      markets: marketsToRun,
      plays,
      generatedAt: new Date().toISOString(),
    };

    analysisCache.set(cacheKey, response, ttl);
    res.json(response);
  } catch (err) {
    next(err);
  }
});

// GET /api/plays/single — analyze a single prop by its raw data
router.post('/single', async (req, res, next) => {
  try {
    const { prop, statsData, matchupData, lineMovement } = req.body;
    if (!prop || !prop.line) {
      return res.status(400).json({ error: 'prop.line is required' });
    }
    const result = analyzeProp(prop, statsData || {}, matchupData || {}, lineMovement || {});
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/plays/verdicts — summary count by verdict for today
router.get('/verdicts', async (req, res, next) => {
  try {
    const allProps = [];
    for (const mkt of DEFAULT_MARKETS) {
      try {
        const events = await getAllPropsForMarket(mkt);
        const props = parsePropsFromEvents(events, mkt);
        allProps.push(...props);
      } catch (err) { /* skip */ }
    }

    const propsWithData = await Promise.all(
      allProps.map(async (prop) => ({
        prop,
        statsData: await enrichStats(prop),
        matchupData: await enrichMatchup(prop),
        lineMovement: await getLineMovement(prop),
      }))
    );

    const allResults = propsWithData.map(({ prop, statsData, matchupData, lineMovement }) =>
      analyzeProp(prop, statsData, matchupData, lineMovement)
    );

    const summary = {
      'Strong Play': allResults.filter(r => r.verdict === 'Strong Play').length,
      'Lean': allResults.filter(r => r.verdict === 'Lean').length,
      'Monitor': allResults.filter(r => r.verdict === 'Monitor').length,
      'Pass': allResults.filter(r => r.verdict === 'Pass').length,
      total: allResults.length,
    };

    res.json({ summary, generatedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────
// Enrichment functions
// Replace these stubs with real data sources
// ─────────────────────────────────────────────────────────────────

/**
 * Enrich a prop with player stats data.
 *
 * TODO: Connect to a real stats source:
 *  - MLB Stats API: https://statsapi.mlb.com/api/v1/people/{playerId}/stats
 *  - Baseball Reference (scrape)
 *  - StatMuse API
 *  - A pre-built stats database you maintain
 *
 * The gate engine expects:
 *  { l5HitRate, l10HitRate, seasonHitRate, h2hHitRate, projection, daysRest }
 *  All are optional — missing values default to neutral (0.5 score)
 */
async function enrichStats(prop) {
  // STUB: Returns plausible-looking data so gates run
  // In production, query your stats DB here by prop.player + prop.propType
  return {
    l5HitRate: null,      // e.g. 80 = 80%
    l10HitRate: null,     // e.g. 70 = 70%
    seasonHitRate: null,  // e.g. 73 = 73%
    h2hHitRate: null,     // vs today's opponent
    projection: null,     // e.g. 6.2 K projected
    daysRest: 0,
  };
}

/**
 * Enrich a prop with matchup + environment data.
 *
 * TODO: Connect to:
 *  - Opponent team stats (lineup K%, hard-hit rate, etc.)
 *  - Park factor database
 *  - Weather API (for outdoor games)
 *
 * The gate engine expects:
 *  { grade, detail, parkFactor }
 *  grade: 'A+' | 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C'
 *  parkFactor: 100 = neutral, <95 = pitcher friendly, >105 = hitter friendly
 */
async function enrichMatchup(prop) {
  return {
    grade: null,       // e.g. 'A'
    detail: null,      // e.g. 'CWS K% 30th in MLB'
    parkFactor: 100,   // neutral default
  };
}

/**
 * Get line movement data for a prop.
 *
 * TODO: To track line movement you need to:
 *  1. Store opening lines when props first appear (on cron at ~9am ET)
 *  2. Compare to current lines at analysis time
 *  This requires a database. The opening line can be saved to Supabase.
 *
 * The gate engine expects:
 *  { opening, current }
 */
async function getLineMovement(prop) {
  return {
    opening: null,        // e.g. 6.5
    current: prop.line,   // current line from odds API
  };
}

module.exports = router;
