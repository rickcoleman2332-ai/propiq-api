const axios = require('axios');
const NodeCache = require('node-cache');

const cache = new NodeCache();

const BASE = process.env.ODDS_API_BASE || 'https://api.the-odds-api.com/v4';
const KEY = process.env.ODDS_API_KEY;

// MLB sport key used by The Odds API
const MLB_KEY = 'baseball_mlb';

// Books we care about (best lines shown in app)
const BOOKS = ['fanduel', 'draftkings', 'betmgm'];

const BOOK_DISPLAY = {
  fanduel:    'FanDuel',
  draftkings: 'DraftKings',
  betmgm:     'BetMGM',
};

// Player prop markets available from The Odds API
const PROP_MARKETS = {
  // Pitcher props
  pitcher_strikeouts:       'Pitcher Strikeouts',
  pitcher_hits_allowed:     'Hits Allowed',
  pitcher_walks:            'Walks',
  pitcher_earned_runs:      'Earned Runs',
  pitcher_outs:             'Pitcher Outs',
  // Hitter props
  batter_total_bases:       'Total Bases',
  batter_hits:              'Hits',
  batter_home_runs:         'Home Runs',
  batter_rbis:              'RBIs',
  batter_runs_scored:       'Runs Scored',
  batter_hits_runs_rbis:    'H+R+RBI',
  batter_stolen_bases:      'Stolen Bases',
};

/**
 * Fetch with cache wrapper
 * @param {string} cacheKey
 * @param {number} ttl - seconds
 * @param {Function} fetchFn
 */
async function withCache(cacheKey, ttl, fetchFn) {
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const result = await fetchFn();
  cache.set(cacheKey, result, ttl);
  return result;
}

/**
 * Get all MLB games for today
 */
async function getTodaysGames() {
  const ttl = parseInt(process.env.ODDS_CACHE_TTL) || 120;
  return withCache('mlb_games_today', ttl, async () => {
    const res = await axios.get(`${BASE}/sports/${MLB_KEY}/odds`, {
      params: {
        apiKey: KEY,
        regions: 'us',
        markets: 'h2h,spreads,totals',
        oddsFormat: 'american',
        dateFormat: 'iso',
      }
    });
    logQuotaUsage(res.headers);
    return res.data;
  });
}

/**
 * Get player props for a specific game and market
 * @param {string} gameId - The Odds API game ID
 * @param {string} market - e.g. 'pitcher_strikeouts'
 */
async function getPropsForGame(gameId, market) {
  const ttl = parseInt(process.env.PROPS_CACHE_TTL) || 120;
  const cacheKey = `props_${gameId}_${market}`;
  return withCache(cacheKey, ttl, async () => {
    const res = await axios.get(`${BASE}/sports/${MLB_KEY}/events/${gameId}/odds`, {
      params: {
        apiKey: KEY,
        regions: 'us',
        markets: market,
        oddsFormat: 'american',
        dateFormat: 'iso',
      }
    });
    logQuotaUsage(res.headers);
    return res.data;
  });
}

/**
 * Get props across ALL today's games for a given market
 * Uses the bulk event-odds endpoint to save quota
 */
async function getAllPropsForMarket(market) {
  const ttl = parseInt(process.env.PROPS_CACHE_TTL) || 120;
  const cacheKey = `all_props_${market}`;
  return withCache(cacheKey, ttl, async () => {
    const res = await axios.get(`${BASE}/sports/${MLB_KEY}/odds`, {
      params: {
        apiKey: KEY,
        regions: 'us',
        markets: market,
        oddsFormat: 'american',
        dateFormat: 'iso',
        bookmakers: BOOKS.join(','),
      }
    });
    logQuotaUsage(res.headers);
    return res.data;
  });
}

/**
 * Get current MLB scores/status (live + completed games)
 */
async function getScores() {
  return withCache('mlb_scores', 60, async () => {
    const res = await axios.get(`${BASE}/sports/${MLB_KEY}/scores`, {
      params: { apiKey: KEY, daysFrom: 1 }
    });
    logQuotaUsage(res.headers);
    return res.data;
  });
}

/**
 * Log remaining API quota from response headers
 */
function logQuotaUsage(headers) {
  const remaining = headers['x-requests-remaining'];
  const used = headers['x-requests-used'];
  if (remaining !== undefined) {
    console.log(`[OddsAPI] Quota — used: ${used}, remaining: ${remaining}`);
    if (parseInt(remaining) < 50) {
      console.warn(`[OddsAPI] ⚠️  Low quota warning: only ${remaining} requests remaining`);
    }
  }
}

/**
 * Get current quota usage without making a data call
 */
async function getQuotaStatus() {
  const res = await axios.get(`${BASE}/sports`, {
    params: { apiKey: KEY }
  });
  return {
    remaining: res.headers['x-requests-remaining'],
    used: res.headers['x-requests-used'],
  };
}

module.exports = {
  getTodaysGames,
  getPropsForGame,
  getAllPropsForMarket,
  getScores,
  getQuotaStatus,
  PROP_MARKETS,
  BOOKS,
  BOOK_DISPLAY,
};
