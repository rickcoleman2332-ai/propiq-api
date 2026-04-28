/**
 * lineMovementCron.js
 * ─────────────────────────────────────────────────────────────────
 * Cron jobs that snapshot prop lines from FanDuel, DraftKings, and
 * BetMGM at key times throughout the day.
 *
 * Schedule:
 *   9:00 AM ET  — Opening line snapshot (most important)
 *   12:00 PM ET — Midday check
 *   3:00 PM ET  — Afternoon check
 *   5:00 PM ET  — Pre-game check (sharp money usually moves lines here)
 *   6:00 PM ET  — Final pre-game snapshot
 *
 * Usage:
 *   Called from src/index.js on server start.
 *   Also exposes runSnapshot() for manual triggering via API.
 *
 * The cron uses node-cron. Times are in ET (UTC-4 in summer, UTC-5 in winter).
 */

const cron = require('node-cron');
const { getAllPropsForMarket, PROP_MARKETS, BOOKS } = require('../services/oddsApi');
const { parsePropsFromEvents } = require('../services/propsParser');
const { saveLines, getSnapshotHistory } = require('../models/lineMovementStore');

// Markets to snapshot (focus on the most-bet props)
const SNAPSHOT_MARKETS = [
  'pitcher_strikeouts',
  'pitcher_hits_allowed',
  'pitcher_walks',
  'pitcher_earned_runs',
  'batter_total_bases',
  'batter_hits',
  'batter_home_runs',
  'batter_hits_runs_rbis',
];

let cronJobs = [];
let isRunning = false;

/**
 * Fetch all props for all markets and save a snapshot
 * @param {string} snapshotType - 'opening' | 'current'
 */
async function runSnapshot(snapshotType) {
  if (!snapshotType) snapshotType = 'current';

  if (isRunning) {
    console.log('[LineMovement] Snapshot already in progress, skipping');
    return { skipped: true };
  }

  isRunning = true;
  const started = Date.now();
  let totalProps = 0;
  let totalSaved = 0;
  const errors = [];

  console.log(`[LineMovement] Starting ${snapshotType} snapshot for ${new Date().toISOString()}`);

  for (const market of SNAPSHOT_MARKETS) {
    try {
      const events = await getAllPropsForMarket(market);
      const props = parsePropsFromEvents(events, market);

      if (props.length === 0) continue;

      totalProps += props.length;
      const saved = saveLines(props, snapshotType);
      totalSaved += saved;

      console.log(`[LineMovement]   ${market}: ${props.length} props, ${saved} lines saved`);

      // Small delay between markets to be respectful to the API
      await sleep(500);

    } catch (err) {
      console.warn(`[LineMovement] Failed market ${market}:`, err.message);
      errors.push({ market, error: err.message });
    }
  }

  isRunning = false;
  const elapsed = Math.round((Date.now() - started) / 1000);

  const result = {
    snapshotType,
    propsFound: totalProps,
    linesSaved: totalSaved,
    marketsProcessed: SNAPSHOT_MARKETS.length - errors.length,
    errors,
    duration: `${elapsed}s`,
    completedAt: new Date().toISOString(),
  };

  console.log(`[LineMovement] Snapshot complete:`, JSON.stringify(result));
  return result;
}

/**
 * Start all cron jobs
 * ET timezone offsets: EST = UTC-5, EDT = UTC-4 (summer)
 * Using America/New_York to handle DST automatically
 */
function startCron() {
  console.log('[LineMovement] Starting line movement cron jobs...');

  // 9:00 AM ET — Opening lines (most critical)
  const job9am = cron.schedule('0 9 * * *', async () => {
    console.log('[LineMovement] CRON: 9am ET opening snapshot');
    await runSnapshot('opening');
  }, { timezone: 'America/New_York' });

  // 12:00 PM ET — Midday check
  const job12pm = cron.schedule('0 12 * * *', async () => {
    console.log('[LineMovement] CRON: 12pm ET midday snapshot');
    await runSnapshot('current');
  }, { timezone: 'America/New_York' });

  // 3:00 PM ET — Afternoon check
  const job3pm = cron.schedule('0 15 * * *', async () => {
    console.log('[LineMovement] CRON: 3pm ET afternoon snapshot');
    await runSnapshot('current');
  }, { timezone: 'America/New_York' });

  // 5:00 PM ET — Pre-game (sharp money window)
  const job5pm = cron.schedule('0 17 * * *', async () => {
    console.log('[LineMovement] CRON: 5pm ET pre-game snapshot');
    await runSnapshot('current');
  }, { timezone: 'America/New_York' });

  // 6:00 PM ET — Final pre-game
  const job6pm = cron.schedule('0 18 * * *', async () => {
    console.log('[LineMovement] CRON: 6pm ET final pre-game snapshot');
    await runSnapshot('current');
  }, { timezone: 'America/New_York' });

  cronJobs = [job9am, job12pm, job3pm, job5pm, job6pm];
  console.log(`[LineMovement] ${cronJobs.length} cron jobs scheduled`);

  return cronJobs;
}

function stopCron() {
  for (const job of cronJobs) job.stop();
  cronJobs = [];
  console.log('[LineMovement] Cron jobs stopped');
}

function getStatus() {
  return {
    jobsActive: cronJobs.length,
    snapshotInProgress: isRunning,
    schedule: [
      '9:00 AM ET  — Opening lines',
      '12:00 PM ET — Midday',
      '3:00 PM ET  — Afternoon',
      '5:00 PM ET  — Pre-game',
      '6:00 PM ET  — Final pre-game',
    ],
    markets: SNAPSHOT_MARKETS,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { startCron, stopCron, runSnapshot, getStatus };
