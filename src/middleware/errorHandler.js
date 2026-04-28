/**
 * middleware/errorHandler.js
 * Global error handler — catches Odds API errors, validation errors, etc.
 */

function errorHandler(err, req, res, next) {
  console.error('[Error]', err.message);

  // Odds API errors
  if (err.response) {
    const status = err.response.status;
    const data = err.response.data;

    if (status === 401) {
      return res.status(502).json({
        error: 'Invalid Odds API key. Check your ODDS_API_KEY in .env',
        detail: data,
      });
    }
    if (status === 422) {
      return res.status(502).json({
        error: 'Odds API rejected request — check market/sport parameters',
        detail: data,
      });
    }
    if (status === 429) {
      return res.status(429).json({
        error: 'Odds API quota exhausted for today',
        detail: 'Upgrade at https://the-odds-api.com or wait until quota resets',
      });
    }
    return res.status(502).json({
      error: `Odds API error: ${status}`,
      detail: data,
    });
  }

  // Network errors
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    return res.status(503).json({ error: 'Could not reach external data provider' });
  }

  // Default
  res.status(500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

module.exports = { errorHandler };
