function requirePermission(permissionKey) {
  return (req, res, next) => {
    if (req.user?.is_platform_admin) {
      return next();
    }

    if (!req.user?.permissions?.includes(permissionKey)) {
      return res.status(403).json({ ok: false, error: "PERMISSION_DENIED", permission: permissionKey });
    }

    return next();
  };
}

module.exports = { requirePermission };
