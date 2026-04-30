const { hasPermission: hasPermissionKey } = require("../utils/tenancy");

function hasPermission(user, permissionKey) {
  if (user?.is_platform_admin) {
    return true;
  }

  return hasPermissionKey(user?.permissions || [], permissionKey);
}

function requirePermission(permissionKey) {
  return (req, res, next) => {
    if (!hasPermission(req.user, permissionKey)) {
      return res.status(403).json({ ok: false, error: "PERMISSION_DENIED", permission: permissionKey });
    }

    return next();
  };
}

module.exports = { hasPermission, requirePermission };
