/**
 * routes/props.js
 * GET /api/props — return all available MLB player props for today
 * GET /api/props/:market — props for a specific market
 * GET /api/props/game/:gameId — props for a specific game
 */

const express = require('express');
const router = express.Router();
const { getAllPropsForMarket, getTodaysGames, getPropsForGame, PROP_MARKETS } = require('../services/oddsApi');
const { parsePropsFromEvents, parsePropsFromGame, isPitcherProp } = require('../services/propsParser');

// GET /api/props/markets — list all available markets
router.get('/markets', (req, res) => {
  res.json({
    markets: Object.entries(PROP_MARKETS).map(([key, label]) => ({
      key,
      label,
      type: isPitcherProp(key) ? 'pitcher' : 'hitter',
    }))
  });
});

// GET /api/props/games — list today's MLB games
router.get('/games', async (req, res, next) => {
  try {
    const games = await getTodaysGames();
    const simplified = games.map(g => ({
      id: g.id,
      homeTeam: g.home_team,
      awayTeam: g.away_team,
      commenceTime: g.commence_time,
      sport: g.sport_key,
    }));
    res.json({ count: simplified.length, games: simplified });
  } catch (err) {
    next(err);
  }
});

// GET /api/props?market=pitcher_strikeouts&type=pitcher
router.get('/', async (req, res, next) => {
  try {
    const { market, type } = req.query;

    // Determine which markets to fetch
    let marketsToFetch = [];

    if (market) {
      if (!PROP_MARKETS[market]) {
        return res.status(400).json({
          error: `Unknown market: ${market}`,
          availableMarkets: Object.keys(PROP_MARKETS),
        });
      }
      marketsToFetch = [market];
    } else if (type === 'pitcher') {
      marketsToFetch = Object.keys(PROP_MARKETS).filter(isPitcherProp);
    } else if (type === 'hitter') {
      marketsToFetch = Object.keys(PROP_MARKETS).filter(m => !isPitcherProp(m));
    } else {
      // Default: most popular markets
      marketsToFetch = ['pitcher_strikeouts', 'batter_total_bases', 'batter_hits'];
    }

    // Fetch all selected markets (sequentially to respect rate limits)
    const allProps = [];
    for (const mkt of marketsToFetch) {
      try {
        const eventsData = await getAllPropsForMarket(mkt);
        const props = parsePropsFromEvents(eventsData, mkt);
        allProps.push(...props);
      } catch (mktErr) {
        console.warn(`[Props] Failed to fetch market ${mkt}:`, mktErr.message);
      }
    }

    res.json({
      count: allProps.length,
      markets: marketsToFetch,
      props: allProps,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/props/game/:gameId?market=pitcher_strikeouts
router.get('/game/:gameId', async (req, res, next) => {
  try {
    const { gameId } = req.params;
    const { market = 'pitcher_strikeouts' } = req.query;

    if (!PROP_MARKETS[market]) {
      return res.status(400).json({ error: `Unknown market: ${market}` });
    }

    const gameOdds = await getPropsForGame(gameId, market);
    const props = parsePropsFromGame(gameOdds, market);

    res.json({
      gameId,
      market,
      count: props.length,
      props,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
