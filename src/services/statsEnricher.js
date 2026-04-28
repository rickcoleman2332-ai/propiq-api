/**
 * statsEnricher.js
 * ─────────────────────────────────────────────────────────────────
 * Takes a parsed prop (from propsParser) and returns fully enriched
 * statsData + matchupData objects ready for the gate engine.
 *
 * This is what replaces the stub enrichStats() / enrichMatchup()
 * functions in routes/plays.js.
 *
 * Workflow per prop:
 *  1. Look up player ID from name (search cache)
 *  2. Fetch game log (last 20 games)
 *  3. Calculate L5, L10, L20, H2H hit rates for the prop line
 *  4. Calculate average projection from last 5 games
 *  5. Fetch opponent team stats → grade matchup
 *  6. Get park factor from venue
 *  7. Calculate days rest from last game
 */

const {
  searchPlayer,
  getPlayerInfo,
  getPitcherGameLog,
  getHitterGameLog,
  getTeamStats,
  getTodaySchedule,
  calcAllHitRates,
  propTypeToStatKey,
  gradeMatchup,
  getParkFactor,
} = require('./mlbStatsApi');

const NodeCache = require('node-cache');
const { getMovement } = require('../models/lineMovementStore');
const enrichCache = new NodeCache();

/**
 * Enrich a single prop with real MLB stats
 * @param {Object} prop - normalized prop from propsParser
 * @returns {{ statsData, matchupData, lineMovement }}
 */
async function enrichProp(prop) {
  const cacheKey = `enriched_${prop.id}`;
  const cached = enrichCache.get(cacheKey);
  if (cached) return cached;

  try {
    const isPitcher = prop.propType.startsWith('pitcher_');
    const statKey = propTypeToStatKey(prop.propType);

    if (!statKey) {
      return defaultEnrichment(prop);
    }

    // Step 1: Find player
    const playerResults = await searchPlayer(prop.player);
    if (!playerResults || playerResults.length === 0) {
      console.warn(`[Enrich] Player not found: ${prop.player}`);
      return defaultEnrichment(prop);
    }

    const player = playerResults[0];
    const playerId = player.id;

    // Step 2: Get game log
    const gameLogs = isPitcher
      ? await getPitcherGameLog(playerId, 20)
      : await getHitterGameLog(playerId, 20);

    if (!gameLogs || gameLogs.length === 0) {
      return defaultEnrichment(prop);
    }

    // Step 3: Find opponent team ID from today's schedule
    const opponentId = await findOpponentId(prop);

    // Step 4: Hit rates
    const hitRates = calcAllHitRates(gameLogs, statKey, prop.line, opponentId);

    // Step 5: Projection (weighted avg of last 5 game actual values)
    const last5Values = gameLogs.slice(0, 5).map(g => g[statKey] || 0);
    const projection = last5Values.length > 0
      ? Math.round((last5Values.reduce((a, b) => a + b, 0) / last5Values.length) * 10) / 10
      : null;

    // Step 6: Days rest (days since last game)
    const daysRest = calcDaysRest(gameLogs);

    // Step 7: Matchup grade
    let matchupGrade = { grade: null, detail: null };
    let parkFactor = 100;

    try {
      const schedule = await getTodaySchedule();
      const gameInfo = findGameInSchedule(schedule, prop);

      if (gameInfo) {
        // Park factor
        parkFactor = gameInfo.venue ? getParkFactor(gameInfo.venue) : 100;

        // Opponent team stats
        const opponentTeamId = getOpponentTeamId(gameInfo, prop, isPitcher);
        if (opponentTeamId) {
          const teamStats = await getTeamStats(opponentTeamId);
          matchupGrade = gradeMatchup(teamStats, isPitcher);
        }
      }
    } catch (schedErr) {
      console.warn(`[Enrich] Schedule/matchup error for ${prop.player}:`, schedErr.message);
    }

    const result = {
      statsData: {
        playerId,
        playerName: player.name,
        l5HitRate: hitRates.l5,
        l10HitRate: hitRates.l10,
        l20HitRate: hitRates.l20,
        seasonHitRate: hitRates.l20, // use l20 as season proxy if no full season calc
        h2hHitRate: hitRates.h2h,
        projection,
        daysRest,
        last5Games: gameLogs.slice(0, 5).map(g => ({
          date: g.date,
          opponent: g.opponent,
          value: g[statKey],
          hit: g[statKey] > prop.line,
        })),
      },
      matchupData: {
        grade: matchupGrade.grade,
        detail: matchupGrade.detail,
        parkFactor,
      },
      lineMovement: (() => { try { return getMovement(prop); } catch(e) { return { opening: null, current: prop.line }; } })(),
    };

    enrichCache.set(cacheKey, result, 300);
    return result;

  } catch (err) {
    console.warn(`[Enrich] Failed to enrich ${prop.player}:`, err.message);
    return defaultEnrichment(prop);
  }
}

/**
 * Enrich multiple props in parallel (with concurrency limit)
 * @param {Object[]} props
 * @returns {Array} props with enrichment attached
 */
async function enrichAllProps(props) {
  // Process in batches of 5 to avoid hammering the MLB API
  const BATCH_SIZE = 5;
  const results = [];

  for (let i = 0; i < props.length; i += BATCH_SIZE) {
    const batch = props.slice(i, i + BATCH_SIZE);
    const enriched = await Promise.all(
      batch.map(async (prop) => {
        const enrichment = await enrichProp(prop);
        return {
          prop,
          statsData: enrichment.statsData,
          matchupData: enrichment.matchupData,
          lineMovement: enrichment.lineMovement,
        };
      })
    );
    results.push(...enriched);
  }

  return results;
}

/**
 * Get enriched stats for a player without a specific prop
 * Used by the matchup browser to show player stats before line selection
 */
async function getPlayerMatchupProfile(playerName, propType, opponentTeamName) {
  try {
    const isPitcher = propType ? propType.startsWith('pitcher_') : false;

    const playerResults = await searchPlayer(playerName);
    if (!playerResults || playerResults.length === 0) {
      return null;
    }

    const player = playerResults[0];
    const playerId = player.id;
    const playerInfo = await getPlayerInfo(playerId);

    const gameLogs = isPitcher
      ? await getPitcherGameLog(playerId, 20)
      : await getHitterGameLog(playerId, 20);

    if (!gameLogs || gameLogs.length === 0) return null;

    const statKey = propType ? propTypeToStatKey(propType) : null;
    const daysRest = calcDaysRest(gameLogs);

    // Recent performance summary
    const last5 = gameLogs.slice(0, 5);
    const last10 = gameLogs.slice(0, 10);

    let recentStats = {};
    if (isPitcher) {
      recentStats = {
        l5AvgK: avg(last5.map(g => g.strikeouts)),
        l10AvgK: avg(last10.map(g => g.strikeouts)),
        l5AvgIP: avg(last5.map(g => g.inningsPitched)),
        l5AvgH: avg(last5.map(g => g.hitsAllowed)),
        l5AvgBB: avg(last5.map(g => g.walksAllowed)),
        l5AvgER: avg(last5.map(g => g.earnedRuns)),
        last5Games: last5.map(g => ({ date: g.date, opp: g.opponent, k: g.strikeouts, ip: g.inningsPitched })),
      };
    } else {
      recentStats = {
        l5AvgTB: avg(last5.map(g => g.totalBases)),
        l10AvgTB: avg(last10.map(g => g.totalBases)),
        l5AvgHits: avg(last5.map(g => g.hits)),
        l5AvgHRRBI: avg(last5.map(g => g.hPlusRPlusRbi)),
        last5Games: last5.map(g => ({ date: g.date, opp: g.opponent, h: g.hits, tb: g.totalBases, hr: g.homeRuns })),
      };
    }

    // Matchup grade vs opponent
    let matchupGrade = null;
    if (opponentTeamName) {
      const schedule = await getTodaySchedule();
      const teamEntry = schedule.find(g =>
        g.homeTeam.name === opponentTeamName || g.awayTeam.name === opponentTeamName ||
        g.homeTeam.abbreviation === opponentTeamName || g.awayTeam.abbreviation === opponentTeamName
      );
      if (teamEntry) {
        const oppId = isPitcher
          ? (teamEntry.homeTeam.name === opponentTeamName ? teamEntry.homeTeam.id : teamEntry.awayTeam.id)
          : null;
        if (oppId) {
          const teamStats = await getTeamStats(oppId);
          matchupGrade = gradeMatchup(teamStats, isPitcher);
        }
      }
    }

    return {
      player: playerInfo || { id: playerId, name: player.name },
      daysRest,
      recentStats,
      matchupGrade,
      gameLogs: gameLogs.slice(0, 10),
    };

  } catch (err) {
    console.warn(`[Enrich] getPlayerMatchupProfile error:`, err.message);
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function defaultEnrichment(prop) {
  return {
    statsData: {},
    matchupData: { grade: null, detail: null, parkFactor: 100 },
    lineMovement: { opening: null, current: prop.line },
  };
}

async function findOpponentId(prop) {
  try {
    const schedule = await getTodaySchedule();
    const game = schedule.find(g =>
      g.homeTeam.name === prop.homeTeam || g.awayTeam.name === prop.homeTeam ||
      g.homeTeam.name === prop.awayTeam || g.awayTeam.name === prop.awayTeam
    );
    if (!game) return null;
    // Opponent is the other team in the game
    return null; // TODO: match player to their team first
  } catch {
    return null;
  }
}

function findGameInSchedule(schedule, prop) {
  return schedule.find(g =>
    g.homeTeam.name === prop.homeTeam || g.awayTeam.name === prop.homeTeam ||
    g.homeTeam.name === prop.awayTeam || g.awayTeam.name === prop.awayTeam
  ) || null;
}

function getOpponentTeamId(gameInfo, prop, isPitcher) {
  // For pitchers, opponent is the team batting against them
  // For hitters, opponent is the pitcher's team
  // This is approximate — a real impl would match player → their team first
  if (!gameInfo) return null;
  return gameInfo.awayTeam.id || gameInfo.homeTeam.id;
}

function calcDaysRest(gameLogs) {
  if (!gameLogs || gameLogs.length === 0) return 0;
  const lastGame = gameLogs[0];
  if (!lastGame.date) return 0;
  const last = new Date(lastGame.date);
  const today = new Date();
  const diff = Math.floor((today - last) / (1000 * 60 * 60 * 24));
  return Math.max(0, diff - 1); // subtract 1 because game day = 0 rest
}

function avg(arr) {
  const valid = arr.filter(v => v !== null && v !== undefined);
  if (valid.length === 0) return null;
  return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10;
}

module.exports = { enrichProp, enrichAllProps, getPlayerMatchupProfile };
