const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { body, validationResult } = require("express-validator");
const { pool, logActivity } = require("../config/db");
const { requireAuthAllowExpired } = require("../middleware/auth");
const { insertSubscriptionLog, syncSubscriptionStatus } = require("../utils/subscriptions");
const { loadAuthContext } = require("../utils/tenancy");
const { ensureCompanyProfileSchemaCompatibility } = require("../utils/companyProfileSchema");
const {
  cleanOptional,
  findStateByCode,
  findStateByName,
  isIndianCountry,
  normalizeCountry,
  normalizeStateCode,
} = require("../utils/gst");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const STRONG_PASSWORD_MESSAGE =
  "Password must be at least 8 characters and include uppercase, lowercase, number, and special character";

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ ok: false, error: "Validation failed", details: errors.mapped() });
  }
  return null;
}

function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

function resolveCompanyLocation(payload) {
  const country = normalizeCountry(payload.country);

  if (!isIndianCountry(country)) {
    const stateName = cleanOptional(payload.state_name);
    if (!stateName) {
      const error = new Error("State / region is required");
      error.status = 422;
      throw error;
    }

    return {
      country,
      stateName,
      stateCode: null,
    };
  }

  const stateFromCode = findStateByCode(payload.state_code);
  const stateFromName = findStateByName(payload.state_name);
  const state = stateFromCode || stateFromName;

  if (!state) {
    const error = new Error("State is required for companies in India");
    error.status = 422;
    throw error;
  }

  return {
    country,
    stateName: state.name,
    stateCode: normalizeStateCode(state.code),
  };
}

async function loadUserByEmail(executor, email) {
  const [[user]] = await executor.execute(
    `SELECT
       u.id,
       u.company_id,
       u.email,
       u.password_hash,
       u.must_change_password,
       u.name,
       u.role,
       u.status,
       u.is_platform_admin,
       c.subscription_plan,
       c.subscription_status,
       c.trial_ends_at,
       c.subscription_ends_at
     FROM users u
     LEFT JOIN companies c ON c.id = u.company_id
     WHERE u.email = ?`,
    [email]
  );

  return user || null;
}

router.post(
  "/register",
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("company_name").trim().notEmpty().withMessage("Company name is required"),
    body("country").trim().notEmpty().withMessage("Country is required"),
    body("state_name").optional({ checkFalsy: true }).trim(),
    body("state_code").optional({ checkFalsy: true }).trim(),
    body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
    body("password")
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
      await ensureCompanyProfileSchemaCompatibility(conn);
      await conn.beginTransaction();

      const { name, company_name: companyName, email, password } = req.body;
      const { country, stateName, stateCode } = resolveCompanyLocation(req.body);
      const existing = await loadUserByEmail(conn, email);
      if (existing) {
        await conn.rollback();
        return res.status(409).json({ ok: false, error: "Email already registered" });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const trialEndsAt = new Date();
      trialEndsAt.setDate(trialEndsAt.getDate() + 7);

      const [companyResult] = await conn.execute(
        `INSERT INTO companies (
           name, owner_user_id, created_by_admin, subscription_plan, subscription_status, trial_ends_at, subscription_ends_at
         ) VALUES (?, NULL, 0, 'TRIAL', 'ACTIVE', ?, ?)`,
        [companyName.trim(), trialEndsAt, trialEndsAt]
      );

      const companyId = companyResult.insertId;

      const [userResult] = await conn.execute(
        `INSERT INTO users (
           company_id, email, password_hash, auth_provider, name, role, status,
           email_verified_at, password_set_at, must_change_password
         ) VALUES (?, ?, ?, 'LOCAL', ?, 'MASTER', 'ACTIVE', NOW(), NOW(), 0)`,
        [companyId, email, passwordHash, name.trim()]
      );

      const userId = userResult.insertId;

      await conn.execute(
        "UPDATE companies SET owner_user_id = ? WHERE id = ?",
        [userId, companyId]
      );

      await conn.execute(
        `INSERT INTO company_profiles (company_id, user_id, name, country, state_name, state_code)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [companyId, userId, companyName.trim(), country, stateName, stateCode]
      );

      await logActivity(conn, {
        userId,
        type: "COMPANY_REGISTERED",
        description: `Company created: ${companyName.trim()} by ${name.trim()} (${email})`,
      });

      await insertSubscriptionLog(conn, {
        companyId,
        userId,
        action: "TRIAL_STARTED",
        plan: "TRIAL",
        notes: "7-day trial started on company registration.",
      });

      await conn.commit();

      const token = generateToken(userId);
      const { user, company } = await loadAuthContext(pool, userId);

      return res.status(201).json({
        ok: true,
        message: "Workspace created successfully. Your 7-day trial is active.",
        token,
        user,
        company,
      });
    } catch (error) {
      await conn.rollback();
      next(error);
    } finally {
      conn.release();
    }
  }
);

router.post(
  "/register-with-google",
  [
    body("credential").notEmpty().withMessage("Google credential is required"),
    body("company_name").trim().notEmpty().withMessage("Company name is required"),
    body("country").trim().notEmpty().withMessage("Country is required"),
    body("state_name").optional({ checkFalsy: true }).trim(),
    body("state_code").optional({ checkFalsy: true }).trim(),
    body("password")
      .isStrongPassword({
        minLength: 8,
        minLowercase: 1,
        minUppercase: 1,
        minNumbers: 1,
        minSymbols: 1,
      })
      .withMessage(STRONG_PASSWORD_MESSAGE),
    body("name").optional().trim(),
  ],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    const conn = await pool.getConnection();

    try {
      
      const ticket = await googleClient.verifyIdToken({
        idToken: req.body.credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });

      const payload = ticket.getPayload();
      if (!payload || !payload.email) {
        return res.status(400).json({ ok: false, error: "Invalid Google credential: no email found" });
      }

      if (!payload.email_verified) {
        return res.status(400).json({ ok: false, error: "Google account email is not verified" });
      }

      const googleEmail = payload.email.toLowerCase();
      const googleName = req.body.name?.trim() || payload.name || googleEmail.split("@")[0];
      const googleSub = payload.sub;
      const companyName = req.body.company_name.trim();
      const password = req.body.password;
      const { country, stateName, stateCode } = resolveCompanyLocation(req.body);

      await ensureCompanyProfileSchemaCompatibility(conn);
      await conn.beginTransaction();

      
      const existing = await loadUserByEmail(conn, googleEmail);
      if (existing) {
        await conn.rollback();
        return res.status(409).json({ ok: false, error: "Email already registered" });
      }

      
      const [[existingGoogleUser]] = await conn.execute(
        "SELECT id FROM users WHERE google_sub = ?",
        [googleSub]
      );
      if (existingGoogleUser) {
        await conn.rollback();
        return res.status(409).json({ ok: false, error: "This Google account is already linked to another user" });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const trialEndsAt = new Date();
      trialEndsAt.setDate(trialEndsAt.getDate() + 7);

      const [companyResult] = await conn.execute(
        `INSERT INTO companies (
           name, owner_user_id, created_by_admin, subscription_plan, subscription_status, trial_ends_at, subscription_ends_at
         ) VALUES (?, NULL, 0, 'TRIAL', 'ACTIVE', ?, ?)`,
        [companyName, trialEndsAt, trialEndsAt]
      );

      const companyId = companyResult.insertId;

      const [userResult] = await conn.execute(
        `INSERT INTO users (
           company_id, email, password_hash, auth_provider, google_sub, name, role, status,
           email_verified_at, password_set_at, must_change_password
         ) VALUES (?, ?, ?, 'BOTH', ?, ?, 'MASTER', 'ACTIVE', NOW(), NOW(), 0)`,
        [companyId, googleEmail, passwordHash, googleSub, googleName]
      );

      const userId = userResult.insertId;

      await conn.execute(
        "UPDATE companies SET owner_user_id = ? WHERE id = ?",
        [userId, companyId]
      );

      await conn.execute(
        `INSERT INTO company_profiles (company_id, user_id, name, country, state_name, state_code)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [companyId, userId, companyName, country, stateName, stateCode]
      );

      await logActivity(conn, {
        userId,
        type: "COMPANY_REGISTERED",
        description: `Company created: ${companyName} by ${googleName} (${googleEmail}) — verified via Google`,
      });

      await insertSubscriptionLog(conn, {
        companyId,
        userId,
        action: "TRIAL_STARTED",
        plan: "TRIAL",
        notes: "7-day trial started on company registration (Google-verified).",
      });

      await conn.commit();

      const token = generateToken(userId);
      const { user, company } = await loadAuthContext(pool, userId);

      return res.status(201).json({
        ok: true,
        message: "Workspace created successfully. Your email is verified and 7-day trial is active.",
        token,
        user,
        company,
      });
    } catch (error) {
      await conn.rollback();

      
      if (error.message?.includes("Token used too late") || error.message?.includes("Invalid token")) {
        return res.status(400).json({ ok: false, error: "Google verification expired. Please try again." });
      }

      next(error);
    } finally {
      conn.release();
    }
  }
);

const rateLimit = require("express-rate-limit");

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 5, 
  message: { ok: false, error: "Too many login attempts, please try again after 15 minutes" },
  standardHeaders: true, 
  legacyHeaders: false, 
});

router.post(
  "/login",
  loginLimiter,
  [
    body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
    body("password").notEmpty().withMessage("Password is required"),
  ],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    try {
      const { email, password } = req.body;
      const user = await loadUserByEmail(pool, email);

      if (!user) {
        return res.status(401).json({ ok: false, error: "Invalid email or password" });
      }

      if (!user.password_hash) {
        return res.status(403).json({
          ok: false,
          error: "This account does not have a valid password yet.",
        });
      }

      if (user.status === "DISABLED") {
        const isExpiredSub =
          user.subscription_status === "EXPIRED" ||
          user.subscription_status === "SUSPENDED";

        if (isExpiredSub && user.role === "MASTER") {
          // MASTER with expired subscription — allow through so they can renew.
          // Fall through to password check; they will receive SUBSCRIPTION_EXPIRED warning.
        } else if (isExpiredSub) {
          return res.status(403).json({
            ok: false,
            error: "SUBSCRIPTION_ACCOUNT_DISABLED",
            message:
              "Your account has been deactivated because the workspace subscription has expired. Please contact your workspace administrator to renew the subscription.",
          });
        } else {
          return res.status(403).json({
            ok: false,
            error: "ACCOUNT_DISABLED",
            message: "This account has been disabled by your workspace administrator.",
          });
        }
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ ok: false, error: "Invalid email or password" });
      }

      if (!user.is_platform_admin && user.company_id) {
        await syncSubscriptionStatus(pool, {
          id: user.company_id,
          subscription_plan: user.subscription_plan,
          subscription_status: user.subscription_status,
          subscription_ends_at: user.subscription_ends_at,
        });
      }

      const token = generateToken(user.id);
      const { user: authUser, company } = await loadAuthContext(pool, user.id);

      if (!user.is_platform_admin && authUser?.must_change_password) {
        return res.json({
          ok: true,
          token,
          user: authUser,
          company,
          warning: "MUST_CHANGE_PASSWORD",
          message: "Please change your temporary password before using the workspace.",
        });
      }

      // If syncSubscriptionStatus just disabled this non-master user, hard-reject them.
      if (!user.is_platform_admin && authUser?.status === "DISABLED") {
        const isExpiredSub =
          authUser.sub_status === "EXPIRED" || authUser.sub_status === "SUSPENDED";
        if (isExpiredSub && user.role === "MASTER") {
          // Allow MASTER through — they will hit the SUBSCRIPTION_EXPIRED warning below.
        } else if (isExpiredSub) {
          return res.status(403).json({
            ok: false,
            error: "SUBSCRIPTION_ACCOUNT_DISABLED",
            message:
              "Your account has been deactivated because the workspace subscription has expired. Please contact your workspace administrator to renew the subscription.",
          });
        } else {
          return res.status(403).json({
            ok: false,
            error: "ACCOUNT_DISABLED",
            message: "This account has been disabled by your workspace administrator.",
          });
        }
      }

      if (!user.is_platform_admin && authUser?.sub_status !== "ACTIVE") {
        return res.json({
          ok: true,
          token,
          user: authUser,
          company,
          warning: "SUBSCRIPTION_EXPIRED",
        });
      }

      return res.json({
        ok: true,
        token,
        user: authUser,
        company,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/change-temporary-password",
  requireAuthAllowExpired,
  [
    body("new_password")
      .isStrongPassword({
        minLength: 8,
        minLowercase: 1,
        minUppercase: 1,
        minNumbers: 1,
        minSymbols: 1,
      })
      .withMessage(STRONG_PASSWORD_MESSAGE),
    body("confirm_password")
      .custom((value, { req }) => value === req.body.new_password)
      .withMessage("Passwords do not match"),
  ],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const [[existingUser]] = await conn.execute(
        "SELECT id, must_change_password FROM users WHERE id = ? FOR UPDATE",
        [req.authUserId || req.user.member_id]
      );

      if (!existingUser) {
        await conn.rollback();
        return res.status(404).json({ ok: false, error: "User not found" });
      }

      if (!existingUser.must_change_password) {
        await conn.rollback();
        return res.status(409).json({ ok: false, error: "Temporary password change is not required" });
      }

      const newHash = await bcrypt.hash(req.body.new_password, 12);
      await conn.execute(
        `UPDATE users
         SET password_hash = ?, must_change_password = 0, password_set_at = NOW(), email_verified_at = COALESCE(email_verified_at, NOW())
         WHERE id = ?`,
        [newHash, existingUser.id]
      );

      await logActivity(conn, {
        userId: existingUser.id,
        type: "TEMP_PASSWORD_CHANGED",
        description: "Temporary password replaced by the user on first login.",
      });

      await conn.commit();

      const { user, company } = await loadAuthContext(pool, existingUser.id);
      return res.json({
        ok: true,
        message: "Password updated successfully.",
        user,
        company,
      });
    } catch (error) {
      await conn.rollback();
      next(error);
    } finally {
      conn.release();
    }
  }
);

router.get("/me", requireAuthAllowExpired, async (req, res, next) => {
  try {
    const { user, company } = await loadAuthContext(pool, req.authUserId || req.user.member_id);

    return res.json({
      ok: true,
      user,
      company,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
