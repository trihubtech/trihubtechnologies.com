const { requireAuth } = require("./auth");

async function requirePlatformAdmin(req, res, next) {
  return requireAuth(req, res, () => {
    if (!req.user?.is_platform_admin) {
      return res.status(403).json({ ok: false, error: "PLATFORM_ADMIN_REQUIRED" });
    }

    return next();
  });
}

module.exports = { requirePlatformAdmin };
