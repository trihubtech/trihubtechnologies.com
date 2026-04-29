const jwt = require("jsonwebtoken");
const { pool } = require("../config/db");
const { syncSubscriptionStatus } = require("../utils/subscriptions");
const { loadTenantUser } = require("../utils/tenancy");

function createAuthMiddleware({ allowExpired = false } = {}) {
  return async function authMiddleware(req, res, next) {
    try {
      const header = req.headers.authorization || "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : null;
      if (!token) return res.status(401).json({ ok: false, error: "Unauthorised" });

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await loadTenantUser(pool, decoded.userId);

      if (!user) {
        return res.status(401).json({ ok: false, error: "User not found" });
      }

      if (!user.is_platform_admin && user.status && user.status !== "ACTIVE") {
        // Allow a DISABLED MASTER through if their subscription expired — they need to reach
        // the /subscribe route (requireAuthAllowExpired) to renew. The sub_status check below
        // will still block them from every other route.
        const isMasterWithExpiredSub =
          user.role === "MASTER" &&
          (user.sub_status === "EXPIRED" || user.sub_status === "SUSPENDED");

        if (!isMasterWithExpiredSub) {
          return res.status(403).json({
            ok: false,
            error: "ACCOUNT_INACTIVE",
            message: "Your account is currently inactive. Please contact your workspace administrator.",
          });
        }
      }

      await syncSubscriptionStatus(pool, user);

      if (!allowExpired && !user.is_platform_admin && user.sub_status !== "ACTIVE") {
        return res.status(403).json({ ok: false, error: "SUBSCRIPTION_EXPIRED" });
      }

      req.user = {
        ...user,
        id: user.scope_user_id,
        member_id: user.member_id,
      };
      req.scopeUserId = user.scope_user_id;
      req.authUserId = user.member_id;

      return next();
    } catch (error) {
      return res.status(401).json({ ok: false, error: "Invalid or expired token" });
    }
  };
}

const requireAuth = createAuthMiddleware();
const requireAuthAllowExpired = createAuthMiddleware({ allowExpired: true });

module.exports = { requireAuth, requireAuthAllowExpired };
