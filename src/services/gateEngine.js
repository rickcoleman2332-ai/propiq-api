/**
 * gateEngine.js
 * ─────────────────────────────────────────────────────────────────
 * The PropIQ Gate Analysis Engine
 *
 * Each prop is run through 10 gates. Each gate passes or fails.
 * The model score (0–10) is the sum of weighted gate scores.
 * A final verdict (Strong Play / Lean / Monitor / Pass) is assigned.
 *
 * Gates:
 *  1.  Juice Gate         — Line not too heavily juiced
 *  2.  Line Value Gate    — No-vig math shows positive EV on the over
 *  3.  L5 Form Gate       — Hit rate over last 5 games
 *  4.  L10 Form Gate      — Hit rate over last 10 games
 *  5.  Season Form Gate   — Full 2026 season hit rate
 *  6.  H2H Gate           — Hit rate vs this specific opponent
 *  7.  Matchup Gate       — Quality of opposing pitcher or lineup
 *  8.  Line Movement Gate — Sharp money moved line in our favor
 *  9.  Projection Gate    — Model projection clears the line with buffer
 *  10. Environment Gate   — Park factor, rest days, conditions
 */

const { calculateFairOdds, impliedProbability } = require('./propsParser');

const GATE_WEIGHTS = {
  juice:        0.5,
  lineValue:    1.5,
  l5Form:       1.0,
  l10Form:      1.5,
  seasonForm:   1.0,
  h2hForm:      0.5,
  matchup:      1.5,
  lineMovement: 1.0,
  projection:   1.5,
  environment:  0.5,
};
// Weights sum to 10.0

const VERDICTS = [
  { label: 'Strong Play', minScore: 7.5, confidence: 'High',   stake: '1u' },
  { label: 'Lean',        minScore: 6.0, confidence: 'Medium', stake: '0.5u' },
  { label: 'Monitor',     minScore: 4.5, confidence: 'Low',    stake: null },
  { label: 'Pass',        minScore: 0,   confidence: 'None',   stake: null },
];

function fmt(american) {
  if (american === null || american === undefined) return 'N/A';
  return american > 0 ? `+${american}` : `${american}`;
}

function gradeFromScore(score) {
  if (score >= 9.0) return 'A+';
  if (score >= 8.0) return 'A';
  if (score >= 7.0) return 'A-';
  if (score >= 6.0) return 'B+';
  if (score >= 5.0) return 'B';
  if (score >= 4.0) return 'B-';
  return 'C';
}

function makeGate(name, label, passed, detail, score, extra) {
  return { name, label, passed, detail, weight: GATE_WEIGHTS[name], score, ...extra };
}

/**
 * Run the full 10-gate analysis on a single prop.
 * statsData and matchupData can be empty objects when not yet enriched.
 */
function analyzeProp(prop, statsData, matchupData, lineMovement) {
  if (!statsData) statsData = {};
  if (!matchupData) matchupData = {};
  if (!lineMovement) lineMovement = {};

  const gates = [];

  // Gate 1 — Juice
  const maxJuice = parseInt(process.env.MAX_JUICE) || -160;
  const bestOverOdds = (prop.bestOver && prop.bestOver.over != null) ? prop.bestOver.over : null;
  const juicePasses = bestOverOdds !== null && bestOverOdds >= maxJuice;
  gates.push(makeGate('juice', 'Line Juice', juicePasses,
    bestOverOdds !== null
      ? `Best over: ${fmt(bestOverOdds)} | max allowed: ${maxJuice}`
      : 'No over odds found',
    juicePasses ? 1 : 0, {}));

  // Gate 2 — Line Value
  let lineValuePasses = false;
  let lineValueDetail = 'Insufficient odds data for EV calc';
  let fairOdds = null;
  if (prop.bestOver && prop.bestOver.over && prop.bestUnder && prop.bestUnder.under) {
    fairOdds = calculateFairOdds(prop.bestOver.over, prop.bestUnder.under);
    const impliedProb = impliedProbability(prop.bestOver.over);
    const fairProb = fairOdds.overProb / 100;
    lineValuePasses = fairProb > impliedProb;
    lineValueDetail = `Fair: ${fmt(fairOdds.fairOver)} | Market: ${fmt(prop.bestOver.over)} | EV: ${lineValuePasses ? 'Positive' : 'Negative'}`;
  }
  gates.push(makeGate('lineValue', 'Line Value (EV)', lineValuePasses, lineValueDetail,
    lineValuePasses ? 1 : 0, { fairOdds }));

  // Gate 3 — L5 Form
  const l5 = statsData.l5HitRate != null ? statsData.l5HitRate : null;
  const l5Min = 50;
  const l5Passes = l5 !== null && l5 >= l5Min;
  gates.push(makeGate('l5Form', 'Last 5 Form', l5Passes,
    l5 !== null ? `L5: ${l5}% (min ${l5Min}%)` : 'L5 data unavailable — neutral',
    l5 !== null ? (l5Passes ? 1 : 0) : 0.5, {}));

  // Gate 4 — L10 Form
  const l10 = statsData.l10HitRate != null ? statsData.l10HitRate : null;
  const l10Min = parseInt(process.env.MIN_L10_HIT_RATE) || 60;
  const l10Passes = l10 !== null && l10 >= l10Min;
  gates.push(makeGate('l10Form', 'Last 10 Form', l10Passes,
    l10 !== null ? `L10: ${l10}% (min ${l10Min}%)` : 'L10 data unavailable — neutral',
    l10 !== null ? (l10Passes ? 1 : 0) : 0.5, {}));

  // Gate 5 — Season Form
  const season = statsData.seasonHitRate != null ? statsData.seasonHitRate : null;
  const seasonMin = 55;
  const seasonPasses = season !== null && season >= seasonMin;
  gates.push(makeGate('seasonForm', '2026 Season Rate', seasonPasses,
    season !== null ? `Season: ${season}%` : 'Season data unavailable — neutral',
    season !== null ? (seasonPasses ? 1 : 0) : 0.5, {}));

  // Gate 6 — H2H
  const h2h = statsData.h2hHitRate != null ? statsData.h2hHitRate : null;
  const h2hMin = 50;
  const h2hPasses = h2h !== null && h2h >= h2hMin;
  gates.push(makeGate('h2hForm', 'H2H History', h2hPasses,
    h2h !== null ? `H2H: ${h2h}%` : 'H2H data unavailable — neutral',
    h2h !== null ? (h2hPasses ? 1 : 0) : 0.5, {}));

  // Gate 7 — Matchup
  const grade = matchupData.grade || null;
  const topGrades = ['A+', 'A', 'A-', 'B+'];
  const matchupPasses = grade !== null && topGrades.includes(grade);
  const matchupScore = grade
    ? (matchupPasses ? 1 : (grade === 'B' || grade === 'B-' ? 0.4 : 0))
    : 0.5;
  gates.push(makeGate('matchup', 'Matchup Grade', matchupPasses,
    grade
      ? `Matchup: ${grade}${matchupData.detail ? ' — ' + matchupData.detail : ''}`
      : 'Matchup data unavailable — neutral',
    matchupScore, {}));

  // Gate 8 — Line Movement
  const openLine = lineMovement.opening != null ? lineMovement.opening : null;
  const currLine = lineMovement.current != null ? lineMovement.current : prop.line;
  const movedFav = openLine !== null && currLine < openLine;
  const lineMovePasses = openLine !== null && movedFav;
  gates.push(makeGate('lineMovement', 'Line Movement', lineMovePasses,
    openLine !== null
      ? `Opened: ${openLine} → Now: ${currLine} ${movedFav ? '(steam on over)' : '(no favorable move)'}`
      : 'Opening line unavailable — neutral',
    openLine !== null ? (lineMovePasses ? 1 : 0) : 0.5, {}));

  // Gate 9 — Projection
  const projection = statsData.projection != null ? statsData.projection : null;
  const buffer = 0.5;
  const projPasses = projection !== null && projection >= prop.line + buffer;
  gates.push(makeGate('projection', 'Model Projection', projPasses,
    projection !== null
      ? `Projected: ${projection} vs line: ${prop.line} (need +${buffer})`
      : 'Projection unavailable — neutral',
    projection !== null ? (projPasses ? 1 : 0) : 0.5, {}));

  // Gate 10 — Environment
  const parkFactor = matchupData.parkFactor != null ? matchupData.parkFactor : 100;
  const daysRest = statsData.daysRest != null ? statsData.daysRest : 0;
  const envPasses = daysRest <= 3 && parkFactor >= 90 && parkFactor <= 115;
  gates.push(makeGate('environment', 'Environment', envPasses,
    `Park factor: ${parkFactor} | Rest days: ${daysRest}`,
    envPasses ? 1 : 0, {}));

  // Score
  const rawScore = gates.reduce(function(sum, g) {
    return sum + (g.score * GATE_WEIGHTS[g.name]);
  }, 0);
  const modelScore = Math.round(Math.min(10, rawScore) * 10) / 10;
  const gatesPassed = gates.filter(function(g) { return g.passed; }).length;
  const gatesFailed = gates.filter(function(g) { return !g.passed; }).length;
  const verdict = VERDICTS.find(function(v) { return modelScore >= v.minScore; }) || VERDICTS[VERDICTS.length - 1];
  const minScore = parseFloat(process.env.MIN_MODEL_SCORE) || 6.0;

  return {
    prop: {
      id: prop.id,
      player: prop.player,
      propType: prop.propType,
      propLabel: prop.propLabel,
      line: prop.line,
      gameId: prop.gameId,
      homeTeam: prop.homeTeam,
      awayTeam: prop.awayTeam,
      commenceTime: prop.commenceTime,
      bestOver: prop.bestOver,
      bestUnder: prop.bestUnder,
      bookOdds: prop.bookOdds,
    },
    modelScore: modelScore,
    modelScoreDisplay: modelScore + '/10',
    modelPoints: Math.round(modelScore * 10),
    gatesPassed: gatesPassed,
    gatesFailed: gatesFailed,
    gates: gates,
    matchupGrade: grade || 'N/A',
    marketGrade: lineValuePasses ? 'A' : 'B',
    envGrade: gradeFromScore(modelScore),
    fairOdds: fairOdds,
    projection: projection,
    verdict: verdict.label,
    confidence: verdict.confidence,
    stake: verdict.stake,
    isPlay: modelScore >= minScore,
    analyzedAt: new Date().toISOString(),
  };
}

/**
 * Analyze an array of { prop, statsData, matchupData, lineMovement } objects.
 * Returns only confirmed plays, sorted by modelScore descending.
 */
function analyzeAll(propsWithData) {
  return propsWithData
    .map(function(item) {
      return analyzeProp(item.prop, item.statsData, item.matchupData, item.lineMovement);
    })
    .filter(function(r) { return r.isPlay; })
    .sort(function(a, b) { return b.modelScore - a.modelScore; });
}

module.exports = {
  analyzeProp: analyzeProp,
  analyzeAll: analyzeAll,
  GATE_WEIGHTS: GATE_WEIGHTS,
  VERDICTS: VERDICTS,
  gradeFromScore: gradeFromScore,
  fmt: fmt,
};
