/**
 * propsParser.js
 * Transforms raw Odds API event data into normalized PropIQ prop objects.
 * Each prop has: player, team, opponent, propType, line, bookOdds[], bestBook
 */

const { BOOKS } = require('./oddsApi');

/**
 * Parse all player props from a single game's odds response
 * @param {Object} gameOdds - raw event object from Odds API
 * @param {string} market - e.g. 'pitcher_strikeouts'
 * @returns {PropObject[]}
 */
function parsePropsFromGame(gameOdds, market) {
  if (!gameOdds || !gameOdds.bookmakers) return [];

  const props = {};

  for (const book of gameOdds.bookmakers) {
    if (!BOOKS.includes(book.key)) continue;

    for (const mkt of book.markets) {
      if (mkt.key !== market) continue;

      for (const outcome of mkt.outcomes) {
        // Odds API format: outcome.description = player name, outcome.name = Over/Under
        const player = outcome.description;
        const direction = outcome.name; // 'Over' | 'Under'
        const line = outcome.point;
        const odds = outcome.price;

        if (!player || !line) continue;

        const propKey = `${player}__${market}__${line}`;
        if (!props[propKey]) {
          props[propKey] = {
            id: propKey.replace(/\s+/g, '_').toLowerCase(),
            player,
            propType: market,
            propLabel: marketToLabel(market),
            line,
            gameId: gameOdds.id,
            homeTeam: gameOdds.home_team,
            awayTeam: gameOdds.away_team,
            commenceTime: gameOdds.commence_time,
            bookOdds: [],
            bestOver: null,
            bestUnder: null,
          };
        }

        // Add this book's odds
        let bookEntry = props[propKey].bookOdds.find(b => b.book === book.key);
        if (!bookEntry) {
          bookEntry = { book: book.key, bookName: book.title, over: null, under: null };
          props[propKey].bookOdds.push(bookEntry);
        }
        if (direction === 'Over') bookEntry.over = odds;
        if (direction === 'Under') bookEntry.under = odds;
      }
    }
  }

  // Find best over/under for each prop
  const result = Object.values(props).map(prop => {
    const withOver = prop.bookOdds.filter(b => b.over !== null);
    const withUnder = prop.bookOdds.filter(b => b.under !== null);

    if (withOver.length > 0) {
      prop.bestOver = withOver.reduce((best, b) => b.over > best.over ? b : best);
    }
    if (withUnder.length > 0) {
      prop.bestUnder = withUnder.reduce((best, b) => b.under > best.under ? b : best);
    }

    // Determine player's team from game context (best effort)
    prop.playerTeam = null; // enriched later if stats data available
    prop.opponent = null;   // enriched later

    return prop;
  });

  return result;
}

/**
 * Parse props from multiple games at once (bulk endpoint response)
 * @param {Object[]} eventsData - array of event objects
 * @param {string} market
 * @returns {PropObject[]}
 */
function parsePropsFromEvents(eventsData, market) {
  const allProps = [];
  for (const event of eventsData) {
    const gameProps = parsePropsFromGame(event, market);
    allProps.push(...gameProps);
  }
  return allProps;
}

/**
 * Group props by player (useful when fetching multiple markets)
 * @param {PropObject[]} props
 * @returns {Object} keyed by player name
 */
function groupPropsByPlayer(props) {
  return props.reduce((acc, prop) => {
    if (!acc[prop.player]) acc[prop.player] = [];
    acc[prop.player].push(prop);
    return acc;
  }, {});
}

/**
 * Convert market key to human-readable label
 */
function marketToLabel(market) {
  const labels = {
    pitcher_strikeouts: 'Strikeouts',
    pitcher_hits_allowed: 'Hits Allowed',
    pitcher_walks: 'Walks',
    pitcher_earned_runs: 'Earned Runs',
    pitcher_outs: 'Outs Recorded',
    batter_total_bases: 'Total Bases',
    batter_hits: 'Hits',
    batter_home_runs: 'Home Runs',
    batter_rbis: 'RBIs',
    batter_runs_scored: 'Runs Scored',
    batter_hits_runs_rbis: 'H+R+RBI',
    batter_stolen_bases: 'Stolen Bases',
  };
  return labels[market] || market;
}

/**
 * Determine if a prop is for a pitcher or hitter based on market
 */
function isPitcherProp(market) {
  return market.startsWith('pitcher_');
}

/**
 * Convert American odds to implied probability
 * @param {number} americanOdds
 * @returns {number} 0–1
 */
function impliedProbability(americanOdds) {
  if (americanOdds > 0) {
    return 100 / (americanOdds + 100);
  } else {
    return Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
  }
}

/**
 * Calculate no-vig fair odds from a two-sided market
 * @param {number} overOdds - American
 * @param {number} underOdds - American
 * @returns {{ fairOver: number, fairUnder: number, vig: number }}
 */
function calculateFairOdds(overOdds, underOdds) {
  if (!overOdds || !underOdds) return null;
  const overProb = impliedProbability(overOdds);
  const underProb = impliedProbability(underOdds);
  const total = overProb + underProb;
  const vig = (total - 1) * 100;

  const fairOverProb = overProb / total;
  const fairUnderProb = underProb / total;

  // Convert back to American
  const fairOver = fairOverProb >= 0.5
    ? -(fairOverProb / (1 - fairOverProb)) * 100
    : ((1 - fairOverProb) / fairOverProb) * 100;

  const fairUnder = fairUnderProb >= 0.5
    ? -(fairUnderProb / (1 - fairUnderProb)) * 100
    : ((1 - fairUnderProb) / fairUnderProb) * 100;

  return {
    fairOver: Math.round(fairOver),
    fairUnder: Math.round(fairUnder),
    vig: Math.round(vig * 100) / 100,
    overProb: Math.round(fairOverProb * 100),
    underProb: Math.round(fairUnderProb * 100),
  };
}

module.exports = {
  parsePropsFromGame,
  parsePropsFromEvents,
  groupPropsByPlayer,
  marketToLabel,
  isPitcherProp,
  impliedProbability,
  calculateFairOdds,
};
