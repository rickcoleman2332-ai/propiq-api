/**
 * lineMovementStore.js
 * ─────────────────────────────────────────────────────────────────
 * Persists opening lines for FanDuel, DraftKings, and BetMGM so
 * the gate engine can detect steam moves and line movement.
 *
 * Uses SQLite via the `better-sqlite3` package — a single file DB
 * that requires zero infrastructure. The DB file is created at
 * ./data/lines.db on first run.
 *
 * Schema:
 *   lines (
 *     id          TEXT PRIMARY KEY,   -- prop.id + date + book
 *     prop_id     TEXT,               -- e.g. "jose_soriano__pitcher_strikeouts__5.5"
 *     date        TEXT,               -- "2026-04-28"
 *     book        TEXT,               -- "fanduel" | "draftkings" | "betmgm"
 *     market      TEXT,               -- "pitcher_strikeouts"
 *     player      TEXT,
 *     line        REAL,
 *     over_odds   INTEGER,
 *     under_odds  INTEGER,
 *     snapshot    TEXT,               -- "opening" | "current"
 *     recorded_at TEXT                -- ISO timestamp
 *   )
 */

const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'lines.db');

let db = null;

function getDb() {
  if (db) return db;

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  try {
    const Database = require('better-sqlite3');
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    initSchema(db);
    console.log(`[LineMovement] DB ready at ${DB_PATH}`);
    return db;
  } catch (err) {
    console.warn('[LineMovement] better-sqlite3 not available — using in-memory fallback');
    console.warn('[LineMovement] Run: npm install better-sqlite3');
    return null;
  }
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lines (
      id          TEXT PRIMARY KEY,
      prop_id     TEXT NOT NULL,
      date        TEXT NOT NULL,
      book        TEXT NOT NULL,
      market      TEXT NOT NULL,
      player      TEXT NOT NULL,
      line        REAL NOT NULL,
      over_odds   INTEGER,
      under_odds  INTEGER,
      snapshot    TEXT NOT NULL DEFAULT 'opening',
      recorded_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_lines_prop_date
      ON lines(prop_id, date);

    CREATE INDEX IF NOT EXISTS idx_lines_date
      ON lines(date);

    CREATE TABLE IF NOT EXISTS snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT NOT NULL,
      snapshot    TEXT NOT NULL,
      market      TEXT NOT NULL,
      props_count INTEGER,
      recorded_at TEXT NOT NULL
    );
  `);
}

// ── In-memory fallback (when SQLite not installed) ────────────────
const memStore = {};

function memKey(propId, date, book) {
  return `${propId}__${date}__${book}`;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Save a batch of prop lines as the opening snapshot for today.
 * Only writes if no opening line exists yet for that prop+book+date.
 *
 * @param {Object[]} props - normalized props from propsParser
 * @param {string} snapshot - 'opening' | 'current'
 */
function saveLines(props, snapshot) {
  if (!snapshot) snapshot = 'opening';
  const today = todayStr();
  const now = new Date().toISOString();
  const database = getDb();

  let saved = 0;

  for (const prop of props) {
    for (const bookOdds of (prop.bookOdds || [])) {
      const { book, over, under } = bookOdds;
      if (!book || (over === null && under === null)) continue;

      const id = `${prop.id}__${today}__${book}__${snapshot}`;

      if (database) {
        // SQLite path
        try {
          // For opening lines, only write once per day
          if (snapshot === 'opening') {
            const existing = database.prepare(
              'SELECT id FROM lines WHERE prop_id = ? AND date = ? AND book = ? AND snapshot = ?'
            ).get(prop.id, today, book, 'opening');
            if (existing) continue;
          }

          database.prepare(`
            INSERT OR REPLACE INTO lines
              (id, prop_id, date, book, market, player, line, over_odds, under_odds, snapshot, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(id, prop.id, today, book, prop.propType, prop.player,
                 prop.line, over || null, under || null, snapshot, now);
          saved++;
        } catch (e) {
          console.warn('[LineMovement] Write error:', e.message);
        }
      } else {
        // In-memory fallback
        const key = memKey(prop.id, today, book);
        if (snapshot === 'opening' && memStore[key + '__opening']) continue;
        memStore[key + `__${snapshot}`] = {
          propId: prop.id, date: today, book, market: prop.propType,
          player: prop.player, line: prop.line, overOdds: over,
          underOdds: under, snapshot, recordedAt: now,
        };
        saved++;
      }
    }
  }

  // Log snapshot metadata
  if (database && saved > 0) {
    try {
      database.prepare(`
        INSERT INTO snapshots (date, snapshot, market, props_count, recorded_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(today, snapshot, 'all', saved, now);
    } catch (e) { /* ignore */ }
  }

  console.log(`[LineMovement] Saved ${saved} ${snapshot} lines for ${today}`);
  return saved;
}

/**
 * Get opening line for a prop on a given book
 * @returns {{ line, overOdds, underOdds, recordedAt } | null}
 */
function getOpeningLine(propId, book, date) {
  if (!date) date = todayStr();
  const database = getDb();

  if (database) {
    return database.prepare(
      'SELECT line, over_odds, under_odds, recorded_at FROM lines WHERE prop_id = ? AND book = ? AND date = ? AND snapshot = ?'
    ).get(propId, book, date, 'opening') || null;
  } else {
    return memStore[memKey(propId, date, book) + '__opening'] || null;
  }
}

/**
 * Get all three books' opening lines for a prop
 * Returns the consensus opening line (average across books)
 */
function getOpeningLineConsensus(propId, date) {
  if (!date) date = todayStr();
  const books = ['fanduel', 'draftkings', 'betmgm'];
  const lines = [];

  for (const book of books) {
    const entry = getOpeningLine(propId, book, date);
    if (entry) lines.push({ book, ...entry });
  }

  if (lines.length === 0) return null;

  const avgLine = lines.reduce((sum, l) => sum + l.line, 0) / lines.length;

  return {
    consensus: Math.round(avgLine * 2) / 2, // round to nearest 0.5
    byBook: lines,
    recordedAt: lines[0].recordedAt,
  };
}

/**
 * Get movement for a prop: compare opening to current line
 * @param {Object} prop - current prop with line + bookOdds
 * @returns {LineMovementResult}
 */
function getMovement(prop) {
  const today = todayStr();
  const books = ['fanduel', 'draftkings', 'betmgm'];
  const movements = [];

  for (const book of books) {
    const opening = getOpeningLine(prop.id, book, today);
    const currentBookOdds = (prop.bookOdds || []).find(b => b.book === book);

    if (!opening || !currentBookOdds) continue;

    const lineDiff = opening.line - (currentBookOdds.over !== null ? prop.line : opening.line);
    const oddsDiff = currentBookOdds.over !== null
      ? currentBookOdds.over - (opening.overOdds || opening.over_odds || 0)
      : null;

    movements.push({
      book,
      openingLine: opening.line,
      currentLine: prop.line,
      openingOverOdds: opening.overOdds || opening.over_odds,
      currentOverOdds: currentBookOdds.over,
      lineDiff: Math.round((opening.line - prop.line) * 10) / 10,
      oddsDiff,
      // Positive lineDiff = line moved DOWN = steam on over = good sign
      steamOnOver: opening.line > prop.line,
    });
  }

  if (movements.length === 0) {
    return { opening: null, current: prop.line, hasData: false };
  }

  // Consensus: did the majority of books move toward the over?
  const steamCount = movements.filter(m => m.steamOnOver).length;
  const consensusOpening = movements.reduce((sum, m) => sum + m.openingLine, 0) / movements.length;

  return {
    opening: Math.round(consensusOpening * 10) / 10,
    current: prop.line,
    hasData: true,
    steamOnOver: steamCount >= 2, // majority of books
    steamCount,
    byBook: movements,
    maxLineDiff: Math.max(...movements.map(m => Math.abs(m.lineDiff))),
  };
}

/**
 * Get all line movements for today's slate — used in the UI
 */
function getTodayMovements(market) {
  const today = todayStr();
  const database = getDb();

  if (!database) {
    // Summarize memStore
    return Object.values(memStore)
      .filter(e => e.date === today && e.snapshot === 'opening')
      .map(e => ({ propId: e.propId, player: e.player, book: e.book, line: e.line }));
  }

  const query = market
    ? 'SELECT * FROM lines WHERE date = ? AND market = ? ORDER BY player, book'
    : 'SELECT * FROM lines WHERE date = ? ORDER BY player, book';

  const rows = market
    ? database.prepare(query).all(today, market)
    : database.prepare(query).all(today);

  // Group by propId
  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.prop_id]) {
      grouped[row.prop_id] = { propId: row.prop_id, player: row.player, market: row.market, byBook: {} };
    }
    if (!grouped[row.prop_id].byBook[row.book]) {
      grouped[row.prop_id].byBook[row.book] = {};
    }
    grouped[row.prop_id].byBook[row.book][row.snapshot] = {
      line: row.line, overOdds: row.over_odds, underOdds: row.under_odds, at: row.recorded_at
    };
  }

  return Object.values(grouped);
}

/**
 * Get snapshot history (metadata about when snapshots were taken)
 */
function getSnapshotHistory(date) {
  if (!date) date = todayStr();
  const database = getDb();
  if (!database) return [];
  return database.prepare('SELECT * FROM snapshots WHERE date = ? ORDER BY recorded_at').all(date);
}

/**
 * Clear all data for a specific date (useful for testing)
 */
function clearDate(date) {
  if (!date) date = todayStr();
  const database = getDb();
  if (database) {
    database.prepare('DELETE FROM lines WHERE date = ?').run(date);
    database.prepare('DELETE FROM snapshots WHERE date = ?').run(date);
  } else {
    for (const key of Object.keys(memStore)) {
      if (key.includes(`__${date}__`)) delete memStore[key];
    }
  }
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

module.exports = {
  saveLines,
  getOpeningLine,
  getOpeningLineConsensus,
  getMovement,
  getTodayMovements,
  getSnapshotHistory,
  clearDate,
};
