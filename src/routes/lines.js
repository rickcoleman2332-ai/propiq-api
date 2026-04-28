/**
 * routes/lines.js
 * ─────────────────────────────────────────────────────────────────
 * Endpoints for line movement data and manual snapshot control.
 *
 *  GET  /api/lines                  — all movements for today's slate
 *  GET  /api/lines/:propId          — movement for a specific prop
 *  GET  /api/lines/status           — cron status + snapshot history
 *  POST /api/lines/snapshot         — manually trigger a snapshot
 *  POST /api/lines/snapshot/opening — force a new opening snapshot
 *  GET  /api/lines/best             — best lines across all 3 books right now
 */

const express = require('express');
const router = express.Router();
const { getAllPropsForMarket, PROP_MARKETS, BOOK_DISPLAY } = require('../services/oddsApi');
const { parsePropsFromEvents } = require('../services/propsParser');
const {
  getMovement,
  getTodayMovements,
  getSnapshotHistory,
} = require('../models/lineMovementStore');
const { runSnapshot, getStatus } = require('../services/lineMovementCron');

// GET /api/lines/status
router.get('/status', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const cronStatus = getStatus();
  const history = getSnapshotHistory(today);
  res.json({
    cron: cronStatus,
    snapshotsToday: history.length,
    snapshots: history,
    now: new Date().toISOString(),
  });
});

// GET /api/lines?market=pitcher_strikeouts
router.get('/', async (req, res, next) => {
  try {
    const { market } = req.query;
    const movements = getTodayMovements(market || null);
    res.json({
      count: movements.length,
      date: new Date().toISOString().split('T')[0],
      movements,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/lines/best?market=pitcher_strikeouts — best live lines across all 3 books
router.get('/best', async (req, res, next) => {
  try {
    const { market = 'pitcher_strikeouts' } = req.query;

    if (!PROP_MARKETS[market]) {
      return res.status(400).json({ error: `Unknown market: ${market}` });
    }

    const events = await getAllPropsForMarket(market);
    const props = parsePropsFromEvents(events, market);

    // For each prop, show all 3 books side by side with movement
    const linesData = props.map(prop => {
      const movement = getMovement(prop);

      const bookLines = (prop.bookOdds || []).map(b => ({
        book: b.book,
        bookName: BOOK_DISPLAY ? BOOK_DISPLAY[b.book] || b.bookName : b.bookName,
        line: prop.line,
        over: b.over,
        under: b.under,
        isBestOver: prop.bestOver && prop.bestOver.book === b.book,
        isBestUnder: prop.bestUnder && prop.bestUnder.book === b.book,
      }));

      return {
        player: prop.player,
        propType: prop.propType,
        propLabel: prop.propLabel,
        line: prop.line,
        books: bookLines,
        bestOver: prop.bestOver
          ? { book: prop.bestOver.book, odds: prop.bestOver.over }
          : null,
        bestUnder: prop.bestUnder
          ? { book: prop.bestUnder.book, odds: prop.bestUnder.under }
          : null,
        movement: movement.hasData ? {
          opening: movement.opening,
          current: movement.current,
          diff: movement.opening !== null
            ? Math.round((movement.opening - movement.current) * 10) / 10
            : null,
          steamOnOver: movement.steamOnOver,
          byBook: movement.byBook,
        } : null,
      };
    });

    // Sort by steam (props with sharp movement first)
    linesData.sort((a, b) => {
      const aHasSteam = a.movement?.steamOnOver ? 1 : 0;
      const bHasSteam = b.movement?.steamOnOver ? 1 : 0;
      return bHasSteam - aHasSteam;
    });

    res.json({
      market,
      marketLabel: PROP_MARKETS[market],
      count: linesData.length,
      books: ['FanDuel', 'DraftKings', 'BetMGM'],
      lines: linesData,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/lines/snapshot — trigger a current snapshot manually
router.post('/snapshot', async (req, res, next) => {
  try {
    const { type = 'current' } = req.body;
    if (!['opening', 'current'].includes(type)) {
      return res.status(400).json({ error: 'type must be opening or current' });
    }
    console.log(`[Lines API] Manual ${type} snapshot triggered`);
    const result = await runSnapshot(type);
    res.json({ message: `${type} snapshot complete`, result });
  } catch (err) {
    next(err);
  }
});

// POST /api/lines/snapshot/opening — force new opening snapshot
router.post('/snapshot/opening', async (req, res, next) => {
  try {
    console.log('[Lines API] Manual opening snapshot triggered');
    const result = await runSnapshot('opening');
    res.json({ message: 'Opening snapshot saved', result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
