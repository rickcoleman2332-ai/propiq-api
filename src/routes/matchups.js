/**
 * routes/matchups.js
 * ─────────────────────────────────────────────────────────────────
 * The matchup browser — Step 1 of the PropIQ workflow.
 *
 * Fetches today's slate, enriches each player/pitcher with matchup
 * grades and recent form, and returns a ranked list the user can
 * browse to select players to send to the gate engine.
 *
 * Endpoints:
 *  GET /api/matchups              — full slate ranked by matchup grade
 *  GET /api/matchups/pitchers     — pitchers only
 *  GET /api/matchups/hitters      — hitters only
 *  GET /api/matchups/:playerName  — detailed profile for one player
 *  POST /api/matchups/analyze     — send selected players to gate engine
 */

const express = require('express');
const router = express.Router();
const NodeCache = require('node-cache');

const {
  getTodaySchedule,
  getPitcherGameLog,
  getHitterGameLog,
  getTeamStats,
  searchPlayer,
  getPlayerInfo,
  calcAllHitRates,
  propTypeToStatKey,
  gradeMatchup,
  getParkFactor,
  getAllTeams,
} = require('../services/mlbStatsApi');

const { getPlayerMatchupProfile } = require('../services/statsEnricher');
const { getAllPropsForMarket } = require('../services/oddsApi');
const { parsePropsFromEvents } = require('../services/propsParser');
const { analyzeProp } = require('../services/gateEngine');
const { enrichProp } = require('../services/statsEnricher');

const matchupCache = new NodeCache();

// Grade order for sorting
const GRADE_ORDER = { 'A+': 0, 'A': 1, 'A-': 2, 'B+': 3, 'B': 4, 'B-': 5, 'C': 6, null: 7 };

// ── GET /api/matchups ─────────────────────────────────────────────
// Returns today's full slate with matchup grades, hit rates, and odds
router.get('/', async (req, res, next) => {
  try {
    const { grade, type, limit = 30 } = req.query;
    const cacheKey = `matchups_full_${type || 'all'}`;
    const cached = matchupCache.get(cacheKey);
    if (cached) {
      let result = cached;
      if (grade) result = { ...cached, players: cached.players.filter(p => p.matchupGrade === grade) };
      return res.json({ ...result, fromCache: true });
    }

    const schedule = await getTodaySchedule();

    if (schedule.length === 0) {
      return res.json({ count: 0, players: [], message: 'No games scheduled today' });
    }

    const players = [];

    // Process each game
    for (const game of schedule) {
      const venue = game.venue;
      const parkFactor = getParkFactor(venue);

      // ── Probable pitchers ──────────────────────────────────────
      if (type !== 'hitter') {
        for (const side of ['home', 'away']) {
          const pitcher = game.probablePitchers[side];
          if (!pitcher) continue;

          const opponent = side === 'home' ? game.awayTeam : game.homeTeam;

          try {
            const gameLogs = await getPitcherGameLog(pitcher.id, 20);
            const teamStats = await getTeamStats(opponent.id);
            const matchupGrade = gradeMatchup(teamStats, true);

            // L5/L10 for strikeouts at various lines (we'll use 5.5 as default for display)
            const statKey = 'strikeouts';
            const l5 = gameLogs.slice(0, 5).map(g => g.strikeouts);
            const l10 = gameLogs.slice(0, 10).map(g => g.strikeouts);
            const avgK = l5.length > 0 ? Math.round(l5.reduce((a, b) => a + b, 0) / l5.length * 10) / 10 : null;

            const l5Rate55 = l5.length > 0 ? Math.round(l5.filter(k => k > 5.5).length / l5.length * 100) : null;
            const l10Rate55 = l10.length > 0 ? Math.round(l10.filter(k => k > 5.5).length / l10.length * 100) : null;

            players.push({
              type: 'pitcher',
              playerId: pitcher.id,
              playerName: pitcher.name,
              teamName: side === 'home' ? game.homeTeam.name : game.awayTeam.name,
              teamAbbr: side === 'home' ? game.homeTeam.abbreviation : game.awayTeam.abbreviation,
              opponent: opponent.name,
              opponentAbbr: opponent.abbreviation,
              gameTime: game.gameDate,
              gamePk: game.gamePk,
              venue,
              parkFactor,
              matchupGrade: matchupGrade.grade,
              matchupDetail: matchupGrade.detail,
              avgK,
              l5KHitRate: l5Rate55,
              l10KHitRate: l10Rate55,
              last5KGames: gameLogs.slice(0, 5).map(g => ({ date: g.date, k: g.strikeouts, ip: g.inningsPitched, opp: g.opponent })),
              oppKRate: teamStats ? teamStats.strikeOutRate : null,
            });
          } catch (err) {
            console.warn(`[Matchups] Failed pitcher ${pitcher.name}:`, err.message);
            // Still add with minimal data
            players.push({
              type: 'pitcher',
              playerId: pitcher.id,
              playerName: pitcher.name,
              teamAbbr: side === 'home' ? game.homeTeam.abbreviation : game.awayTeam.abbreviation,
              opponent: opponent.name,
              gameTime: game.gameDate,
              matchupGrade: null,
              matchupDetail: 'Stats loading...',
            });
          }
        }
      }

      // ── Lineup hitters ────────────────────────────────────────
      if (type !== 'pitcher') {
        for (const side of ['home', 'away']) {
          const lineupPlayers = game.lineups[side];
          if (!lineupPlayers || lineupPlayers.length === 0) continue;

          const opponent = side === 'home' ? game.awayTeam : game.homeTeam;
          const oppPitcherId = game.probablePitchers[side === 'home' ? 'away' : 'home']?.id;

          // Get opposing pitcher stats for matchup grade
          let pitcherStats = null;
          if (oppPitcherId) {
            try {
              const pitcherLog = await getPitcherGameLog(oppPitcherId, 10);
              const last5ERA = pitcherLog.slice(0, 5);
              pitcherStats = {
                avgER: last5ERA.length > 0 ? avg(last5ERA.map(g => g.earnedRuns)) : null,
                avgK: last5ERA.length > 0 ? avg(last5ERA.map(g => g.strikeouts)) : null,
              };
            } catch (e) { /* skip */ }
          }

          // Only process top 6 hitters (batting order 1-6 = most PAs)
          for (const hitter of lineupPlayers.slice(0, 6)) {
            try {
              const gameLogs = await getHitterGameLog(hitter.id, 20);
              const l5 = gameLogs.slice(0, 5);
              const l10 = gameLogs.slice(0, 10);

              const avgTB = l5.length > 0 ? Math.round(avg(l5.map(g => g.totalBases)) * 10) / 10 : null;
              const l5TBRate = l5.length > 0 ? Math.round(l5.filter(g => g.totalBases > 1.5).length / l5.length * 100) : null;
              const l10TBRate = l10.length > 0 ? Math.round(l10.filter(g => g.totalBases > 1.5).length / l10.length * 100) : null;

              // Rough matchup grade based on recent hitter performance
              const matchupGrade = gradeHitterMatchup(avgTB, l10TBRate);

              players.push({
                type: 'hitter',
                playerId: hitter.id,
                playerName: hitter.name,
                teamName: side === 'home' ? game.homeTeam.name : game.awayTeam.name,
                teamAbbr: side === 'home' ? game.homeTeam.abbreviation : game.awayTeam.abbreviation,
                opponent: opponent.name,
                opponentAbbr: opponent.abbreviation,
                gameTime: game.gameDate,
                gamePk: game.gamePk,
                venue,
                parkFactor,
                matchupGrade: matchupGrade.grade,
                matchupDetail: matchupGrade.detail,
                avgTB,
                l5TBHitRate: l5TBRate,
                l10TBHitRate: l10TBRate,
                last5Games: l5.map(g => ({ date: g.date, h: g.hits, tb: g.totalBases, hr: g.homeRuns, opp: g.opponent })),
              });
            } catch (err) {
              console.warn(`[Matchups] Failed hitter ${hitter.name}:`, err.message);
            }
          }
        }
      }
    }

    // Sort by matchup grade, then hit rate
    players.sort((a, b) => {
      const gradeDiff = (GRADE_ORDER[a.matchupGrade] || 7) - (GRADE_ORDER[b.matchupGrade] || 7);
      if (gradeDiff !== 0) return gradeDiff;
      const aRate = a.l10KHitRate || a.l10TBHitRate || 0;
      const bRate = b.l10KHitRate || b.l10TBHitRate || 0;
      return bRate - aRate;
    });

    const response = {
      date: new Date().toISOString().split('T')[0],
      gamesCount: schedule.length,
      count: players.length,
      players: players.slice(0, parseInt(limit)),
    };

    matchupCache.set(cacheKey, response, 600);
    res.json(response);

  } catch (err) {
    next(err);
  }
});

// ── GET /api/matchups/pitchers ─────────────────────────────────────
router.get('/pitchers', async (req, res, next) => {
  req.query.type = 'pitcher';
  next();
}, async (req, res, next) => {
  req.url = '/';
  router.handle(req, res, next);
});

// ── GET /api/matchups/hitters ──────────────────────────────────────
router.get('/hitters', (req, res, next) => {
  req.query.type = 'hitter';
  req.url = '/';
  router.handle(req, res, next);
});

// ── GET /api/matchups/player/:name ────────────────────────────────
// Detailed profile for a single player — shown when user taps a player
router.get('/player/:name', async (req, res, next) => {
  try {
    const { name } = req.params;
    const { propType = 'pitcher_strikeouts', opponent } = req.query;

    const profile = await getPlayerMatchupProfile(
      decodeURIComponent(name),
      propType,
      opponent
    );

    if (!profile) {
      return res.status(404).json({ error: `Player not found: ${name}` });
    }

    res.json(profile);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/matchups/schedule ────────────────────────────────────
// Today's games with probable pitchers
router.get('/schedule', async (req, res, next) => {
  try {
    const schedule = await getTodaySchedule();
    res.json({ count: schedule.length, games: schedule });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/matchups/analyze ────────────────────────────────────
// Step 2: User selects players → send to gate engine for full analysis
// Body: { players: [{ playerName, propType, line }] }
router.post('/analyze', async (req, res, next) => {
  try {
    const { players } = req.body;

    if (!players || !Array.isArray(players) || players.length === 0) {
      return res.status(400).json({
        error: 'Provide players array: [{ playerName, propType, line }]'
      });
    }

    if (players.length > 10) {
      return res.status(400).json({ error: 'Max 10 players per request' });
    }

    const results = [];

    for (const item of players) {
      const { playerName, propType, line } = item;
      if (!playerName || !propType || !line) continue;

      try {
        // Find this player's prop from today's odds
        const events = await getAllPropsForMarket(propType);
        const props = parsePropsFromEvents(events, propType);
        const prop = props.find(p =>
          p.player.toLowerCase().includes(playerName.toLowerCase()) ||
          playerName.toLowerCase().includes(p.player.toLowerCase())
        );

        if (!prop) {
          results.push({
            playerName,
            propType,
            line,
            error: 'No odds found for this player/prop today',
          });
          continue;
        }

        // Enrich and analyze
        const enrichment = await enrichProp(prop);
        const analysis = analyzeProp(
          prop,
          enrichment.statsData,
          enrichment.matchupData,
          enrichment.lineMovement
        );

        results.push(analysis);
      } catch (err) {
        results.push({ playerName, propType, line, error: err.message });
      }
    }

    // Sort by model score
    results.sort((a, b) => (b.modelScore || 0) - (a.modelScore || 0));

    res.json({
      count: results.length,
      plays: results.filter(r => r.isPlay),
      others: results.filter(r => !r.isPlay && !r.error),
      errors: results.filter(r => r.error),
      analyzedAt: new Date().toISOString(),
    });

  } catch (err) {
    next(err);
  }
});

// ── Helpers ───────────────────────────────────────────────────────

function gradeHitterMatchup(avgTB, l10HitRate) {
  if (avgTB === null) return { grade: null, detail: 'Insufficient data' };
  if (avgTB >= 2.5 && l10HitRate >= 80) return { grade: 'A', detail: `Avg ${avgTB} TB | L10: ${l10HitRate}%` };
  if (avgTB >= 2.0 && l10HitRate >= 70) return { grade: 'A-', detail: `Avg ${avgTB} TB | L10: ${l10HitRate}%` };
  if (avgTB >= 1.8 && l10HitRate >= 60) return { grade: 'B+', detail: `Avg ${avgTB} TB | L10: ${l10HitRate}%` };
  if (avgTB >= 1.5) return { grade: 'B', detail: `Avg ${avgTB} TB | L10: ${l10HitRate}%` };
  return { grade: 'B-', detail: `Avg ${avgTB} TB — limited recent production` };
}

function avg(arr) {
  const valid = arr.filter(v => v !== null && v !== undefined);
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

module.exports = router;
