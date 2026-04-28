/**
 * test.js — PropIQ API unit tests
 * Run: node src/test.js
 */

require('dotenv').config();
const { analyzeProp, gradeFromScore } = require('./services/gateEngine');
const { calculateFairOdds, impliedProbability, marketToLabel } = require('./services/propsParser');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    → ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${b}, got ${a}`);
}

console.log('\nPropIQ Gate Engine Tests\n');

// ── Parser Tests ──────────────────────────────────────────────────
console.log('propsParser');

test('impliedProbability — favorite', () => {
  const p = impliedProbability(-144);
  assert(p > 0.58 && p < 0.60, `Got ${p}`);
});

test('impliedProbability — underdog', () => {
  const p = impliedProbability(+108);
  assert(p > 0.47 && p < 0.49, `Got ${p}`);
});

test('calculateFairOdds — returns over and under', () => {
  const r = calculateFairOdds(-144, +108);
  assert(r.fairOver < 0, 'fairOver should be negative (favorite)');
  assert(r.fairUnder > 0, 'fairUnder should be positive');
  assert(r.overProb + r.underProb === 100, 'probabilities should sum to 100');
});

test('marketToLabel — known market', () => {
  assertEqual(marketToLabel('pitcher_strikeouts'), 'Strikeouts');
});

test('marketToLabel — unknown falls back', () => {
  assertEqual(marketToLabel('unknown_market'), 'unknown_market');
});

// ── Gate Engine Tests ─────────────────────────────────────────────
console.log('\ngateEngine');

const baseProp = {
  id: 'test_prop',
  player: 'José Soriano',
  propType: 'pitcher_strikeouts',
  propLabel: 'Strikeouts',
  line: 5.5,
  gameId: 'game_1',
  homeTeam: 'Chicago White Sox',
  awayTeam: 'Los Angeles Angels',
  commenceTime: new Date().toISOString(),
  bestOver: { book: 'fanduel', bookName: 'FanDuel', over: -144, under: null },
  bestUnder: { book: 'fanduel', bookName: 'FanDuel', over: null, under: 108 },
  bookOdds: [{ book: 'fanduel', bookName: 'FanDuel', over: -144, under: 108 }],
};

test('analyzeProp — returns result with all required fields', () => {
  const result = analyzeProp(baseProp);
  assert(result.modelScore !== undefined, 'modelScore missing');
  assert(result.verdict !== undefined, 'verdict missing');
  assert(result.gates.length === 10, `Expected 10 gates, got ${result.gates.length}`);
  assert(result.gatesPassed + result.gatesFailed === 10, 'gate counts dont add up');
});

test('analyzeProp — score is between 0 and 10', () => {
  const result = analyzeProp(baseProp);
  assert(result.modelScore >= 0 && result.modelScore <= 10,
    `Score out of range: ${result.modelScore}`);
});

test('analyzeProp — strong stats produce high score', () => {
  const statsData = {
    l5HitRate: 100,
    l10HitRate: 100,
    seasonHitRate: 100,
    h2hHitRate: 80,
    projection: 7.2,
    daysRest: 0,
  };
  const matchupData = { grade: 'A', detail: 'Perfect matchup', parkFactor: 100 };
  const lineMovement = { opening: 6.0, current: 5.5 };

  const result = analyzeProp(baseProp, statsData, matchupData, lineMovement);
  assert(result.modelScore >= 7.5, `Expected ≥7.5, got ${result.modelScore}`);
  assertEqual(result.verdict, 'Strong Play');
});

test('analyzeProp — poor stats produce low score', () => {
  const statsData = {
    l5HitRate: 20,
    l10HitRate: 20,
    seasonHitRate: 20,
    h2hHitRate: 10,
    projection: 3.0,
    daysRest: 5,
  };
  const matchupData = { grade: 'C', parkFactor: 80 };
  const result = analyzeProp(baseProp, statsData, matchupData);
  assert(result.modelScore < 6.0, `Expected <6.0, got ${result.modelScore}`);
  assert(!result.isPlay, 'Should not be flagged as a play');
});

test('analyzeProp — handles missing stats gracefully (no crash)', () => {
  const result = analyzeProp(baseProp, {}, {}, {});
  assert(result.modelScore !== undefined);
  assertEqual(result.gates.length, 10);
});

test('analyzeProp — juice gate fails when over too juiced', () => {
  const heavyProp = {
    ...baseProp,
    bestOver: { book: 'fanduel', over: -200 },
    bestUnder: { book: 'fanduel', under: +160 },
  };
  const result = analyzeProp(heavyProp);
  const juiceGate = result.gates.find(g => g.name === 'juice');
  assert(!juiceGate.passed, 'Juice gate should fail at -200');
});

test('gradeFromScore — correct letter grades', () => {
  assertEqual(gradeFromScore(9.5), 'A+');
  assertEqual(gradeFromScore(8.5), 'A');
  assertEqual(gradeFromScore(7.5), 'A-');
  assertEqual(gradeFromScore(6.5), 'B+');
  assertEqual(gradeFromScore(5.5), 'B');
  assertEqual(gradeFromScore(4.5), 'B-');
  assertEqual(gradeFromScore(2.0), 'C');
});

// ── Summary ───────────────────────────────────────────────────────
console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
