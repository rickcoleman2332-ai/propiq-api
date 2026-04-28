# PropIQ API v1.0
**MLB Player Props Analysis Engine**

Fetches live odds from The Odds API, runs each prop through a 10-gate analysis engine, and returns ranked plays with model scores, verdicts, and fair odds calculations.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# → Add your ODDS_API_KEY from https://the-odds-api.com

# 3. Start the server
npm run dev        # development (auto-reload)
npm start          # production

# 4. Run tests
npm test
```

---

## Architecture

```
src/
├── index.js                  — Express app entry point
├── routes/
│   ├── props.js              — Raw prop fetching endpoints
│   ├── plays.js              — Analyzed plays (main endpoint)
│   ├── bankroll.js           — Bet tracking + bankroll stats
│   └── health.js             — Liveness + quota check
├── services/
│   ├── oddsApi.js            — The Odds API wrapper (with caching)
│   ├── propsParser.js        — Normalize raw API data → PropObjects
│   └── gateEngine.js         — 10-gate analysis engine
├── models/
│   └── bankrollStore.js      — In-memory bet/bankroll store
└── middleware/
    ├── auth.js               — API key validation
    └── errorHandler.js       — Global error handling
```

---

## The PropIQ Workflow

```
Step 1: Browse slate         GET /api/matchups
        → All pitchers + hitters graded A/B/C by matchup quality
        → Filter by grade, type, or game

Step 2: Drill into a player  GET /api/matchups/player/:name
        → Full game log, hit rates at any line, matchup breakdown

Step 3: Send to gate engine  POST /api/matchups/analyze
        → Body: [{ playerName, propType, line }]
        → Returns full 10-gate analysis + verdict for each player

Step 4: Browse all plays     GET /api/plays
        → Auto-runs all three steps for the full slate
        → Returns only confirmed plays (Strong Play / Lean)
```

---

## API Reference

All protected routes require:
```
Authorization: Bearer <API_SECRET_KEY>
```
In development (no key set), all routes are open.

---

### Health

#### `GET /health`
Liveness check.
```json
{ "status": "ok", "version": "1.0.0", "uptime": 42 }
```

#### `GET /health/quota`
Check remaining Odds API quota.
```json
{ "quota": { "remaining": "482", "used": "18" } }
```

---

### Matchup Browser (Step 1 & 2)

#### `GET /api/matchups` ⭐ Start here
Today's full slate ranked by matchup grade. Pitchers graded on opponent K%. Hitters graded on recent TB production.

**Query params:** `type=pitcher|hitter`, `grade=A|A-|B+`, `limit=30`

**Response:**
```json
{
  "gamesCount": 8,
  "count": 24,
  "players": [
    {
      "type": "pitcher",
      "playerName": "José Soriano",
      "teamAbbr": "LAA",
      "opponent": "Chicago White Sox",
      "gameTime": "2026-04-28T22:40:00Z",
      "matchupGrade": "A",
      "matchupDetail": "Opp K% 28% — elite strikeout target",
      "avgK": 7.2,
      "l5KHitRate": 100,
      "l10KHitRate": 100,
      "oppKRate": 28,
      "parkFactor": 100,
      "last5KGames": [
        { "date": "2026-04-27", "opp": "CWS", "k": 8, "ip": 6 }
      ]
    }
  ]
}
```

#### `GET /api/matchups/pitchers`
Pitchers only, sorted by matchup grade.

#### `GET /api/matchups/hitters`
Top 6 hitters from each lineup, sorted by matchup grade.

#### `GET /api/matchups/schedule`
Today's games with probable pitchers and lineups.

#### `GET /api/matchups/player/:name?propType=pitcher_strikeouts`
Detailed profile for a single player — last 10 games, all stat averages, matchup grade.

#### `POST /api/matchups/analyze` ⭐ Send to gate engine
After browsing, select your players and send them here for full 10-gate analysis.

```json
{
  "players": [
    { "playerName": "José Soriano", "propType": "pitcher_strikeouts", "line": 5.5 },
    { "playerName": "Aaron Judge",  "propType": "batter_total_bases",  "line": 1.5 }
  ]
}
```

Response is the same full gate analysis as `/api/plays`, but only for the players you selected.

---

### Props (raw data)

#### `GET /api/props/markets`
List all available prop markets.

#### `GET /api/props/games`
Today's MLB games with IDs and start times.

#### `GET /api/props?market=pitcher_strikeouts`
All props for a market across today's slate.

**Query params:**
- `market` — specific market key (see `/api/props/markets`)
- `type` — `pitcher` or `hitter` (returns all markets of that type)

#### `GET /api/props/game/:gameId?market=pitcher_strikeouts`
Props for one game.

---

### Plays (gate-analyzed)

#### `GET /api/plays` ⭐ Main endpoint
Today's analyzed plays, ranked by model score. Only returns plays that pass the minimum score threshold.

**Query params:**
| Param | Default | Description |
|---|---|---|
| `market` | *(all default markets)* | Filter to one market |
| `type` | — | `pitcher` or `hitter` |
| `verdict` | — | `Strong Play` or `Lean` |
| `minScore` | `6.0` | Minimum model score (0–10) |
| `limit` | `20` | Max plays returned |

**Response:**
```json
{
  "count": 3,
  "totalAnalyzed": 47,
  "plays": [
    {
      "prop": {
        "player": "José Soriano",
        "propLabel": "Strikeouts",
        "line": 5.5,
        "bestOver": { "book": "fanduel", "over": -144 },
        "bestUnder": { "book": "fanduel", "under": 108 }
      },
      "modelScore": 8.7,
      "modelScoreDisplay": "8.7/10",
      "gatesPassed": 10,
      "gatesFailed": 0,
      "gates": [ ... ],
      "matchupGrade": "A",
      "marketGrade": "A",
      "fairOdds": {
        "fairOver": -131,
        "fairUnder": 111,
        "overProb": 57,
        "underProb": 43,
        "vig": 3.2
      },
      "verdict": "Strong Play",
      "confidence": "High",
      "stake": "1u",
      "isPlay": true
    }
  ]
}
```

#### `POST /api/plays/single`
Analyze a single prop with custom data.
```json
{
  "prop": { "player": "Aaron Judge", "line": 1.5, "propLabel": "Total Bases", ... },
  "statsData": { "l10HitRate": 80, "seasonHitRate": 73, "projection": 2.2 },
  "matchupData": { "grade": "A-", "parkFactor": 100 },
  "lineMovement": { "opening": 1.5, "current": 1.5 }
}
```

#### `GET /api/plays/verdicts`
Summary count: how many Strong Plays, Leans, etc. are on today's slate.

---

### Bankroll

#### `GET /api/bankroll`
Full bankroll stats + recent bets.
```json
{
  "bankroll": { "balance": 1240, "startingBalance": 1000 },
  "stats": {
    "wins": 32, "losses": 15, "winRate": 68,
    "totalUnits": 24, "roi": 14.2
  },
  "recentBets": [ ... ]
}
```

#### `POST /api/bankroll/bet`
Record a new bet.
```json
{
  "player": "José Soriano",
  "propLabel": "Strikeouts",
  "line": 5.5,
  "direction": "over",
  "odds": -144,
  "units": 1
}
```

#### `PUT /api/bankroll/bet/:id`
Settle a bet.
```json
{ "result": "win", "actualValue": 8 }
```

#### `PUT /api/bankroll/balance`
Reset bankroll.
```json
{ "amount": 1000 }
```

---

## The 10-Gate Engine

Each prop passes through these gates. The model score (0–10) is the weighted sum.

| # | Gate | Weight | What it checks |
|---|------|--------|----------------|
| 1 | Juice | 0.5 | Over odds not more than max juice (-160 default) |
| 2 | Line Value | 1.5 | No-vig fair odds show positive EV on the over |
| 3 | L5 Form | 1.0 | Last 5 hit rate ≥ 50% |
| 4 | L10 Form | 1.5 | Last 10 hit rate ≥ 60% |
| 5 | Season | 1.0 | 2026 season hit rate ≥ 55% |
| 6 | H2H | 0.5 | Hit rate vs today's opponent ≥ 50% |
| 7 | Matchup | 1.5 | Opponent grade A+/A/A-/B+ |
| 8 | Line Movement | 1.0 | Line moved down (sharp action on over) |
| 9 | Projection | 1.5 | Projection ≥ line + 0.5 buffer |
| 10 | Environment | 0.5 | Park factor 90–115 + rest days ≤ 3 |

**Verdict thresholds:**
- **Strong Play** — ≥ 7.5 → 1u stake
- **Lean** — ≥ 6.0 → 0.5u stake
- **Monitor** — ≥ 4.5 → no stake
- **Pass** — < 4.5

---

## Data Sources

**Odds:** The Odds API (your key in `.env`) — lines, best books, over/under odds

**Stats + Schedules:** MLB Stats API (free, no key) — `statsapi.mlb.com`
- Game logs: last 20 games per player
- Season stats, probable pitchers, lineups
- Team K%, OPS for matchup grading

The `mlbStatsApi.js` service handles all of this automatically. The `statsEnricher.js` service ties it together, enriching each prop with real hit rates, projections, and matchup grades before the gate engine runs.

**One remaining gap — line movement:** To track line movement you need to store opening lines when they first appear (~9am ET). This requires a database write on a cron job. Implement in `models/lineMovementStore.js` with Supabase or SQLite.

---

## Caching

All Odds API calls are cached in memory to protect your quota:
- Odds/games: 2 minutes (configurable via `ODDS_CACHE_TTL`)
- Analysis results: 5 minutes (configurable via `ANALYSIS_CACHE_TTL`)

---

## Production Checklist

- [ ] Set `API_SECRET_KEY` to a strong random string
- [ ] Replace in-memory `bankrollStore.js` with Supabase/Postgres
- [ ] Implement `enrichStats()` with real MLB stats API
- [ ] Add a cron job to log opening lines (for line movement tracking)
- [ ] Deploy to Railway, Render, or Fly.io
- [ ] Add Stripe subscriptions for user management

---

### Line Movement (FanDuel · DraftKings · BetMGM)

Line movement is tracked via cron jobs that snapshot all 3 books throughout the day.

**Cron schedule (ET):**

| Time | Action |
|------|--------|
| 9:00 AM | Opening lines captured — most important |
| 12:00 PM | Midday snapshot |
| 3:00 PM | Afternoon snapshot |
| 5:00 PM | Pre-game (sharp money window) |
| 6:00 PM | Final pre-game snapshot |

Lines stored in `data/lines.db` (SQLite, auto-created on first run). Falls back to in-memory if `better-sqlite3` is not installed.

#### `GET /api/lines/best?market=pitcher_strikeouts`
Live side-by-side lines for all 3 books with steam move indicators.

#### `GET /api/lines/status`
Cron status and today's snapshot history.

#### `POST /api/lines/snapshot`
Manual snapshot trigger: `{ "type": "current" | "opening" }`
