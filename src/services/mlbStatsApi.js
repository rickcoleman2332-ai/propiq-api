/**
 * mlbStatsApi.js
 * ─────────────────────────────────────────────────────────────────
 * Wrapper for the official MLB Stats API (statsapi.mlb.com)
 * No API key required. Free and official.
 *
 * Docs: https://statsapi.mlb.com/docs/
 *
 * What this provides:
 *  - Today's schedule + game IDs
 *  - Starting lineups + probable pitchers
 *  - Player game logs (last N games)
 *  - Player season stats
 *  - Team stats (K%, hard-hit rate, wOBA, etc.)
 *  - Player search by name
 */

const https = require('https');
const NodeCache = require('node-cache');

const cache = new NodeCache();
const BASE = 'https://statsapi.mlb.com/api/v1';

// ── HTTP helper (no external deps, uses built-in https) ───────────
function get(path, params) {
  return new Promise((resolve, reject) => {
    const query = params
      ? '?' + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
      : '';
    const url = `${BASE}${path}${query}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`MLB API returned ${res.statusCode} for ${url}`));
            return;
          }
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse MLB API response: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function withCache(key, ttl, fn) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = await fn();
  cache.set(key, result, ttl);
  return result;
}

// ── Today's Schedule ─────────────────────────────────────────────

/**
 * Get today's MLB schedule with probable pitchers and lineups
 * @returns {Game[]}
 */
async function getTodaySchedule() {
  return withCache('mlb_schedule_today', 300, async () => {
    const today = getTodayStr();
    const data = await get('/schedule', {
      sportId: 1,
      date: today,
      hydrate: 'probablePitcher,lineups,team,venue',
      fields: 'dates,games,gamePk,gameDate,status,teams,venue,probablePitcher,lineups',
    });

    const games = [];
    for (const dateEntry of (data.dates || [])) {
      for (const game of (dateEntry.games || [])) {
        games.push(normalizeGame(game));
      }
    }
    return games;
  });
}

function normalizeGame(game) {
  const home = game.teams?.home || {};
  const away = game.teams?.away || {};

  return {
    gamePk: game.gamePk,
    gameDate: game.gameDate,
    status: game.status?.abstractGameState || 'Scheduled',
    venue: game.venue?.name || null,
    homeTeam: {
      id: home.team?.id,
      name: home.team?.name,
      abbreviation: home.team?.abbreviation,
    },
    awayTeam: {
      id: away.team?.id,
      name: away.team?.name,
      abbreviation: away.team?.abbreviation,
    },
    probablePitchers: {
      home: home.probablePitcher
        ? { id: home.probablePitcher.id, name: home.probablePitcher.fullName }
        : null,
      away: away.probablePitcher
        ? { id: away.probablePitcher.id, name: away.probablePitcher.fullName }
        : null,
    },
    lineups: {
      home: (game.lineups?.homePlayers || []).map(p => ({ id: p.id, name: p.fullName })),
      away: (game.lineups?.awayPlayers || []).map(p => ({ id: p.id, name: p.fullName })),
    },
  };
}

// ── Player Game Logs ─────────────────────────────────────────────

/**
 * Get a pitcher's last N game logs for strikeout hit rate calc
 * @param {number} playerId
 * @param {number} limit - how many recent games (default 20 for L10+L20)
 */
async function getPitcherGameLog(playerId, limit) {
  if (!limit) limit = 20;
  return withCache(`pitcher_log_${playerId}`, 600, async () => {
    const season = getCurrentSeason();
    const data = await get(`/people/${playerId}/stats`, {
      stats: 'gameLog',
      season: season,
      group: 'pitching',
      limit: limit,
    });

    const splits = data.stats?.[0]?.splits || [];
    return splits.map(s => ({
      date: s.date,
      opponent: s.opponent?.name || s.opponent?.abbreviation,
      opponentId: s.opponent?.id,
      strikeouts: parseInt(s.stat?.strikeOuts || 0),
      inningsPitched: parseFloat(s.stat?.inningsPitched || 0),
      hitsAllowed: parseInt(s.stat?.hits || 0),
      walksAllowed: parseInt(s.stat?.baseOnBalls || 0),
      earnedRuns: parseInt(s.stat?.earnedRuns || 0),
      pitchCount: parseInt(s.stat?.numberOfPitches || 0),
    }));
  });
}

/**
 * Get a hitter's last N game logs for total bases, hits, H+R+RBI
 */
async function getHitterGameLog(playerId, limit) {
  if (!limit) limit = 20;
  return withCache(`hitter_log_${playerId}`, 600, async () => {
    const season = getCurrentSeason();
    const data = await get(`/people/${playerId}/stats`, {
      stats: 'gameLog',
      season: season,
      group: 'hitting',
      limit: limit,
    });

    const splits = data.stats?.[0]?.splits || [];
    return splits.map(s => ({
      date: s.date,
      opponent: s.opponent?.name || s.opponent?.abbreviation,
      opponentId: s.opponent?.id,
      atBats: parseInt(s.stat?.atBats || 0),
      hits: parseInt(s.stat?.hits || 0),
      doubles: parseInt(s.stat?.doubles || 0),
      triples: parseInt(s.stat?.triples || 0),
      homeRuns: parseInt(s.stat?.homeRuns || 0),
      totalBases: calcTotalBases(s.stat),
      rbi: parseInt(s.stat?.rbi || 0),
      runs: parseInt(s.stat?.runs || 0),
      hPlusRPlusRbi: (parseInt(s.stat?.hits||0) + parseInt(s.stat?.runs||0) + parseInt(s.stat?.rbi||0)),
      stolenBases: parseInt(s.stat?.stolenBases || 0),
      strikeOuts: parseInt(s.stat?.strikeOuts || 0),
    }));
  });
}

/**
 * Get a player's full season stats
 */
async function getSeasonStats(playerId, group) {
  if (!group) group = 'hitting';
  return withCache(`season_stats_${playerId}_${group}`, 900, async () => {
    const season = getCurrentSeason();
    const data = await get(`/people/${playerId}/stats`, {
      stats: 'season',
      season: season,
      group: group,
    });
    return data.stats?.[0]?.splits?.[0]?.stat || null;
  });
}

/**
 * Get player info (name, position, team, handedness)
 */
async function getPlayerInfo(playerId) {
  return withCache(`player_info_${playerId}`, 3600, async () => {
    const data = await get(`/people/${playerId}`, {
      hydrate: 'currentTeam,stats(type=season,group=hitting)',
    });
    const p = data.people?.[0];
    if (!p) return null;
    return {
      id: p.id,
      name: p.fullName,
      position: p.primaryPosition?.abbreviation,
      bats: p.batSide?.code,
      throws: p.pitchHand?.code,
      teamId: p.currentTeam?.id,
      teamName: p.currentTeam?.name,
      teamAbbr: p.currentTeam?.abbreviation,
    };
  });
}

/**
 * Search for a player by name — returns matching players
 */
async function searchPlayer(name) {
  return withCache(`search_${name.toLowerCase()}`, 3600, async () => {
    const data = await get('/people/search', {
      names: name,
      sportId: 1,
      season: getCurrentSeason(),
    });
    return (data.people || []).map(p => ({
      id: p.id,
      name: p.useName + ' ' + p.lastName,
      fullName: p.fullName,
      position: p.primaryPosition?.abbreviation,
      teamName: p.currentTeam?.name,
      active: p.active,
    })).filter(p => p.active);
  });
}

// ── Team Stats (for matchup grades) ──────────────────────────────

/**
 * Get a team's season stats — used to grade matchup quality
 * For pitchers: opposing team's K%, wOBA, hard-hit rate
 * For hitters: opposing pitcher's ERA, WHIP, hard-hit rate
 */
async function getTeamStats(teamId) {
  return withCache(`team_stats_${teamId}`, 900, async () => {
    const season = getCurrentSeason();
    const data = await get(`/teams/${teamId}/stats`, {
      stats: 'season',
      group: 'hitting',
      season: season,
    });

    const stat = data.stats?.[0]?.splits?.[0]?.stat || {};
    return {
      teamId,
      avg: parseFloat(stat.avg || 0),
      obp: parseFloat(stat.obp || 0),
      slg: parseFloat(stat.slg || 0),
      ops: parseFloat(stat.ops || 0),
      strikeOutRate: stat.atBats && stat.strikeOuts
        ? Math.round((parseInt(stat.strikeOuts) / (parseInt(stat.atBats) + parseInt(stat.baseOnBalls||0))) * 100)
        : null,
      rPerGame: parseFloat(stat.runsPer9Inn || stat.runs || 0),
    };
  });
}

/**
 * Get all 30 MLB teams (used for mapping)
 */
async function getAllTeams() {
  return withCache('mlb_teams', 86400, async () => {
    const data = await get('/teams', { sportId: 1, season: getCurrentSeason() });
    return (data.teams || []).map(t => ({
      id: t.id,
      name: t.name,
      abbreviation: t.abbreviation,
      division: t.division?.name,
      league: t.league?.name,
    }));
  });
}

// ── Hit Rate Calculators ──────────────────────────────────────────

/**
 * Calculate hit rate for a pitcher prop (e.g. strikeouts)
 * @param {Object[]} gameLogs
 * @param {string} statKey - 'strikeouts' | 'hitsAllowed' | 'walksAllowed' | 'earnedRuns'
 * @param {number} line - the prop line
 * @param {number} lastN - window size (5, 10, 20)
 * @param {number|null} opponentId - for H2H filter
 */
function calcHitRate(gameLogs, statKey, line, lastN, opponentId) {
  let games = [...gameLogs];

  if (opponentId) {
    games = games.filter(g => g.opponentId === opponentId);
  } else {
    games = games.slice(0, lastN);
  }

  if (games.length === 0) return null;

  const hits = games.filter(g => (g[statKey] || 0) > line).length;
  return Math.round((hits / games.length) * 100);
}

/**
 * Calculate all hit rates at once for a prop
 * Returns { l5, l10, l20, season, h2h }
 */
function calcAllHitRates(gameLogs, statKey, line, opponentId) {
  return {
    l5: calcHitRate(gameLogs, statKey, line, 5),
    l10: calcHitRate(gameLogs, statKey, line, 10),
    l20: calcHitRate(gameLogs, statKey, line, 20),
    h2h: opponentId ? calcHitRate(gameLogs, statKey, line, 999, opponentId) : null,
  };
}

/**
 * Map prop type to the game log stat key
 */
function propTypeToStatKey(propType) {
  const map = {
    pitcher_strikeouts: 'strikeouts',
    pitcher_hits_allowed: 'hitsAllowed',
    pitcher_walks: 'walksAllowed',
    pitcher_earned_runs: 'earnedRuns',
    batter_total_bases: 'totalBases',
    batter_hits: 'hits',
    batter_home_runs: 'homeRuns',
    batter_rbis: 'rbi',
    batter_runs_scored: 'runs',
    batter_hits_runs_rbis: 'hPlusRPlusRbi',
    batter_stolen_bases: 'stolenBases',
  };
  return map[propType] || null;
}

/**
 * Grade a matchup based on opponent team stats
 * For pitchers: how bad is the opposing lineup?
 * For hitters: how bad is the opposing pitcher?
 */
function gradeMatchup(teamStats, isPitcher) {
  if (!teamStats) return { grade: null, detail: 'Stats unavailable' };

  const kRate = teamStats.strikeOutRate;
  const ops = teamStats.ops;

  if (isPitcher) {
    // Higher K rate = better matchup for pitcher
    if (kRate >= 28) return { grade: 'A', detail: `Opp K% ${kRate}% — elite strikeout target` };
    if (kRate >= 25) return { grade: 'A-', detail: `Opp K% ${kRate}% — strong strikeout matchup` };
    if (kRate >= 22) return { grade: 'B+', detail: `Opp K% ${kRate}% — above avg K rate` };
    if (kRate >= 19) return { grade: 'B', detail: `Opp K% ${kRate}% — average lineup` };
    if (kRate >= 16) return { grade: 'B-', detail: `Opp K% ${kRate}% — below avg K rate` };
    return { grade: 'C', detail: `Opp K% ${kRate}% — tough lineup to strike out` };
  } else {
    // Higher OPS = worse pitcher matchup = better for hitter props
    if (ops >= 0.800) return { grade: 'C', detail: `Opp OPS ${ops} — pitcher is struggling` };
    if (ops >= 0.750) return { grade: 'B-', detail: `Opp OPS ${ops} — slightly hitter friendly` };
    if (ops >= 0.700) return { grade: 'B', detail: `Opp OPS ${ops} — average pitcher` };
    if (ops >= 0.660) return { grade: 'B+', detail: `Opp OPS ${ops} — above avg pitcher` };
    if (ops >= 0.630) return { grade: 'A-', detail: `Opp OPS ${ops} — strong pitcher` };
    return { grade: 'A', detail: `Opp OPS ${ops} — elite pitcher matchup for hitter` };
  }
}

// ── Park Factors ──────────────────────────────────────────────────
// 2026 approximate park factors (100 = neutral)
const PARK_FACTORS = {
  'Coors Field': 115,
  'Great American Ball Park': 108,
  'Fenway Park': 106,
  'Citizens Bank Park': 105,
  'Yankee Stadium': 104,
  'Globe Life Field': 100,
  'Wrigley Field': 102,
  'Dodger Stadium': 97,
  'Oracle Park': 93,
  'Petco Park': 92,
  'T-Mobile Park': 94,
  'Tropicana Field': 95,
  'loanDepot park': 93,
};

function getParkFactor(venueName) {
  if (!venueName) return 100;
  return PARK_FACTORS[venueName] || 100;
}

// ── Helpers ───────────────────────────────────────────────────────

function calcTotalBases(stat) {
  if (!stat) return 0;
  const h = parseInt(stat.hits || 0);
  const d = parseInt(stat.doubles || 0);
  const t = parseInt(stat.triples || 0);
  const hr = parseInt(stat.homeRuns || 0);
  return h + d + (t * 2) + (hr * 3);
}

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function getCurrentSeason() {
  return new Date().getFullYear().toString();
}

module.exports = {
  getTodaySchedule,
  getPitcherGameLog,
  getHitterGameLog,
  getSeasonStats,
  getPlayerInfo,
  searchPlayer,
  getTeamStats,
  getAllTeams,
  calcHitRate,
  calcAllHitRates,
  propTypeToStatKey,
  gradeMatchup,
  getParkFactor,
};
