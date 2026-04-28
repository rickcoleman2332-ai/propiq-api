/**
 * middleware/auth.js
 * Validates the API secret key from the Authorization header.
 * In production, replace this with JWT or Supabase Auth.
 */

function authMiddleware(req, res, next) {
  // In development with no key set, allow all requests
  const secret = process.env.API_SECRET_KEY;
  if (!secret || secret === 'change_me_in_production') {
    return next();
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Unauthorized — provide: Authorization: Bearer <your_api_key>'
    });
  }

  const token = authHeader.slice(7);
  if (token !== secret) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
}

module.exports = { authMiddleware };
