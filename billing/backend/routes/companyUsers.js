const bcrypt = require("bcryptjs");
const router = require("express").Router();
const { body, param, validationResult } = require("express-validator");
const { pool, logActivity } = require("../config/db");
const { requirePermission } = require("../middleware/permissions");
const { cleanPermissionList, PERMISSION_DEFINITIONS, normalizeRole } = require("../utils/tenancy");

const STRONG_PASSWORD_MESSAGE =
  "Temporary password must be at least 8 characters and include uppercase, lowercase, number, and special character";

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ ok: false, error: "Validation failed", details: errors.mapped() });
  }
  return null;
}

async function syncUserPermissions(executor, userId, permissions) {
  const cleanedPermissions = cleanPermissionList(permissions);

  await executor.execute("DELETE FROM user_permissions WHERE user_id = ?", [userId]);

  if (cleanedPermissions.length === 0) {
    return;
  }

  const values = cleanedPermissions.map(() => "(?, ?)").join(", ");
  const params = cleanedPermissions.flatMap((permissionKey) => [userId, permissionKey]);
  await executor.execute(
    `INSERT INTO user_permissions (user_id, permission_key) VALUES ${values}`,
    params
  );
}

router.get("/permissions", requirePermission("can_view_users"), async (req, res) => {
  return res.json({ ok: true, data: PERMISSION_DEFINITIONS });
});

router.get("/", requirePermission("can_list_users"), async (req, res, next) => {
  try {
    const [users] = await pool.execute(
      `SELECT
         u.id,
         u.name,
         u.email,
         u.role,
         u.status,
         u.must_change_password,
         u.created_at,
         GROUP_CONCAT(up.permission_key ORDER BY up.permission_key SEPARATOR ',') AS permissions
       FROM users u
       LEFT JOIN user_permissions up ON up.user_id = u.id
       WHERE u.company_id = ? AND u.is_platform_admin = 0
       GROUP BY u.id, u.name, u.email, u.role, u.status, u.must_change_password, u.created_at
       ORDER BY
         CASE
           WHEN u.role IN ('MASTER', 'OWNER') THEN 0
           WHEN u.role = 'ADMIN' THEN 1
           ELSE 2
         END,
         u.created_at ASC`,
      [req.user.company_id]
    );

    return res.json({
      ok: true,
      data: users.map((user) => ({
        ...user,
        role: normalizeRole(user.role),
        must_change_password: Boolean(user.must_change_password),
        permissions: cleanPermissionList((user.permissions || "").split(",").filter(Boolean)),
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/",
  requirePermission("can_add_users"),
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
    body("role").isIn(["ADMIN", "NORMAL"]).withMessage("Role must be ADMIN or NORMAL"),
    body("permissions").optional().isArray().withMessage("Permissions must be an array"),
    body("temporary_password")
      .isStrongPassword({
        minLength: 8,
        minLowercase: 1,
        minUppercase: 1,
        minNumbers: 1,
        minSymbols: 1,
      })
      .withMessage(STRONG_PASSWORD_MESSAGE),
  ],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const { name, email, role, temporary_password: temporaryPassword } = req.body;
      const permissions = cleanPermissionList(req.body.permissions || []);

      const [[existing]] = await conn.execute(
        "SELECT id FROM users WHERE email = ?",
        [email]
      );

      if (existing) {
        await conn.rollback();
        return res.status(409).json({ ok: false, error: "That email is already in use" });
      }

      const passwordHash = await bcrypt.hash(temporaryPassword, 12);
      const [userResult] = await conn.execute(
        `INSERT INTO users (
           company_id, email, password_hash, auth_provider, name, role, status,
           invited_by, invited_at, password_set_at, must_change_password
         ) VALUES (?, ?, ?, 'LOCAL', ?, ?, 'ACTIVE', ?, NOW(), NOW(), 1)`,
        [
          req.user.company_id,
          email,
          passwordHash,
          name.trim(),
          role,
          req.authUserId || req.user.member_id,
        ]
      );

      await syncUserPermissions(conn, userResult.insertId, role === "MASTER" ? [] : permissions);

      await logActivity(conn, {
        userId: req.authUserId || req.user.member_id,
        type: "USER_CREATED_WITH_TEMP_PASSWORD",
        description: `${name.trim()} created in the workspace as ${role}.`,
        metadata: { targetUserId: userResult.insertId, email, role },
      });

      await conn.commit();

      return res.status(201).json({
        ok: true,
        message: "User created successfully. Share the temporary password and ask them to change it on first login.",
        data: {
          id: userResult.insertId,
          email,
          role,
          must_change_password: true,
          permissions,
        },
      });
    } catch (error) {
      await conn.rollback();
      next(error);
    } finally {
      conn.release();
    }
  }
);

router.patch(
  "/:id",
  requirePermission("can_edit_users"),
  [
    param("id").isInt().toInt(),
    body("role").optional().isIn(["MASTER", "ADMIN", "NORMAL"]).withMessage("Invalid role"),
    body("status").optional().isIn(["ACTIVE", "DISABLED"]).withMessage("Invalid status"),
    body("permissions").optional().isArray().withMessage("Permissions must be an array"),
  ],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const [[member]] = await conn.execute(
        `SELECT id, company_id, role
         FROM users
         WHERE id = ? AND company_id = ? AND is_platform_admin = 0
         FOR UPDATE`,
        [req.params.id, req.user.company_id]
      );

      if (!member) {
        await conn.rollback();
        return res.status(404).json({ ok: false, error: "User not found" });
      }

      if (member.id === (req.authUserId || req.user.member_id) && req.body.status === "DISABLED") {
        await conn.rollback();
        return res.status(409).json({ ok: false, error: "You cannot disable your own account" });
      }

      const nextRole = req.body.role || normalizeRole(member.role);
      const nextStatus = req.body.status || "ACTIVE";

      await conn.execute(
        "UPDATE users SET role = ?, status = ? WHERE id = ?",
        [nextRole, nextStatus, member.id]
      );

      if (Array.isArray(req.body.permissions)) {
        await syncUserPermissions(conn, member.id, nextRole === "MASTER" ? [] : req.body.permissions);
      }

      await logActivity(conn, {
        userId: req.authUserId || req.user.member_id,
        type: "USER_UPDATED",
        description: `Workspace user #${member.id} updated.`,
        metadata: { targetUserId: member.id, role: nextRole, status: nextStatus },
      });

      await conn.commit();
      return res.json({ ok: true, message: "User updated successfully" });
    } catch (error) {
      await conn.rollback();
      next(error);
    } finally {
      conn.release();
    }
  }
);

module.exports = router;
