const router = require("express").Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { body, validationResult } = require("express-validator");
const { pool, logActivity } = require("../config/db");
const { requirePlatformAdmin } = require("../middleware/adminAuth");
const { activateSubscription, suspendSubscription } = require("../utils/subscriptions");


const qrUploadsDir = path.join(__dirname, "../uploads/platform");

function ensurePlatformDir() {
  if (!fs.existsSync(qrUploadsDir)) {
    fs.mkdirSync(qrUploadsDir, { recursive: true });
  }
}

const qrStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensurePlatformDir();
    cb(null, qrUploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `payment_qr_${Date.now()}${ext}`);
  },
});

const qrUpload = multer({
  storage: qrStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp)$/i;
    if (!allowed.test(path.extname(file.originalname))) {
      cb(new Error("Only image files (JPG, PNG, GIF, WebP) are allowed for QR codes"));
      return;
    }
    cb(null, true);
  },
});

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ ok: false, error: "Validation failed", details: errors.mapped() });
  }
  return null;
}


router.get("/payment-qr", async (req, res, next) => {
  try {
    const [settings] = await pool.execute(
      "SELECT setting_key, setting_value FROM platform_settings WHERE setting_key IN ('payment_qr_image', 'payment_upi_id', 'payment_upi_mobile')"
    );

    const data = {
      qr_image_url: null,
      upi_id: null,
      upi_mobile: null,
    };

    for (const row of settings) {
      if (row.setting_key === 'payment_qr_image') data.qr_image_url = row.setting_value;
      if (row.setting_key === 'payment_upi_id') data.upi_id = row.setting_value;
      if (row.setting_key === 'payment_upi_mobile') data.upi_mobile = row.setting_value;
    }

    return res.json({
      ok: true,
      data,
    });
  } catch (error) {
    next(error);
  }
});

router.use(requirePlatformAdmin);

router.get("/companies", async (req, res, next) => {
  try {
    const [companies] = await pool.execute(
      `SELECT
         c.id AS company_id,
         c.name AS company_name,
         c.subscription_plan AS sub_plan,
         c.subscription_status AS sub_status,
         c.trial_ends_at,
         c.subscription_ends_at AS sub_ends_at,
         c.created_by_admin,
         c.created_at,
         owner.id AS owner_user_id,
         owner.name AS owner_name,
         owner.email AS owner_email,
         cp.phone,
         cp.gstin,
         cp.storage_used_bytes
       FROM companies c
       LEFT JOIN users owner ON owner.id = c.owner_user_id
       LEFT JOIN company_profiles cp ON cp.company_id = c.id
       ORDER BY c.created_at DESC`
    );

    const [users] = await pool.execute(
      `SELECT id, name, email, mobile, role, status, company_id, invited_by, profile_picture
       FROM users 
       WHERE is_platform_admin = 0 AND company_id IS NOT NULL`
    );

    const usersByCompany = {};
    for (const u of users) {
      if (!usersByCompany[u.company_id]) {
        usersByCompany[u.company_id] = [];
      }
      usersByCompany[u.company_id].push(u);
    }

    const enhancedCompanies = companies.map(c => ({
      ...c,
      users: usersByCompany[c.company_id] || []
    }));

    return res.json({ ok: true, data: enhancedCompanies });
  } catch (error) {
    next(error);
  }
});

router.get("/companies/:companyId", async (req, res, next) => {
  try {
    const companyId = Number(req.params.companyId);

    const [[company]] = await pool.execute(
      `SELECT
         c.id AS company_id,
         c.name AS company_name,
         c.subscription_plan AS sub_plan,
         c.subscription_status AS sub_status,
         c.trial_ends_at,
         c.subscription_ends_at AS sub_ends_at,
         c.created_by_admin,
         c.created_at,
         owner.id AS owner_user_id,
         owner.name AS owner_name,
         owner.email AS owner_email,
         cp.*
       FROM companies c
       LEFT JOIN users owner ON owner.id = c.owner_user_id
       LEFT JOIN company_profiles cp ON cp.company_id = c.id
       WHERE c.id = ?`,
      [companyId]
    );

    if (!company) {
      return res.status(404).json({ ok: false, error: "Company not found" });
    }

    const [subscriptionLogs] = await pool.execute(
      `SELECT sl.*, reviewer.name AS changed_by_name
       FROM subscription_logs sl
       LEFT JOIN users reviewer ON reviewer.id = sl.changed_by
       WHERE sl.company_id = ?
       ORDER BY sl.created_at DESC`,
      [companyId]
    );

    const [paymentRequests] = await pool.execute(
      `SELECT pr.*, reviewer.name AS reviewed_by_name
       FROM payment_requests pr
       LEFT JOIN users reviewer ON reviewer.id = pr.reviewed_by
       WHERE pr.company_id = ?
       ORDER BY pr.created_at DESC`,
      [companyId]
    );

    return res.json({
      ok: true,
      data: {
        company,
        usage: {
          storage_used_bytes: company.storage_used_bytes || 0,
          payment_request_count: paymentRequests.length,
          subscription_log_count: subscriptionLogs.length,
        },
        subscription_logs: subscriptionLogs,
        payment_requests: paymentRequests,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.patch(
  "/companies/:companyId/activate",
  [body("plan").isIn(["MONTHLY", "YEARLY"]).withMessage("Plan must be MONTHLY or YEARLY"), body("notes").optional().trim()],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const companyId = Number(req.params.companyId);
      const { plan, notes } = req.body;
      const { subEndsAt } = await activateSubscription(conn, {
        companyId,
        plan,
        changedBy: req.authUserId || req.user.member_id,
        notes: notes || "Subscription activated from platform admin panel.",
      });

      await logActivity(conn, {
        userId: req.authUserId || req.user.member_id,
        type: "SUBSCRIPTION_ACTIVATED",
        description: `Company #${companyId} subscription activated on ${plan} plan.`,
        metadata: { changedBy: req.authUserId || req.user.member_id, companyId, plan, subEndsAt },
      });

      await conn.commit();

      return res.json({
        ok: true,
        message: `Company subscription activated on ${plan.toLowerCase()} plan.`,
        data: { company_id: companyId, plan, sub_ends_at: subEndsAt },
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
  "/companies/:companyId/suspend",
  [body("notes").optional().trim()],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const companyId = Number(req.params.companyId);
      await suspendSubscription(conn, {
        companyId,
        changedBy: req.authUserId || req.user.member_id,
        notes: req.body.notes || "Subscription suspended from platform admin panel.",
      });

      await logActivity(conn, {
        userId: req.authUserId || req.user.member_id,
        type: "SUBSCRIPTION_SUSPENDED",
        description: `Company #${companyId} subscription suspended by platform admin.`,
        metadata: { changedBy: req.authUserId || req.user.member_id, companyId },
      });

      await conn.commit();

      return res.json({
        ok: true,
        message: "Company subscription suspended successfully.",
      });
    } catch (error) {
      await conn.rollback();
      next(error);
    } finally {
      conn.release();
    }
  }
);

router.get("/feedbacks", async (req, res, next) => {
  try {
    const [feedbacks] = await pool.execute(
      `SELECT
         f.id,
         f.rating,
         f.comment,
         f.created_at,
         c.name AS company_name,
         u.name AS user_name,
         u.email AS user_email
       FROM company_feedbacks f
       INNER JOIN companies c ON c.id = f.company_id
       INNER JOIN users u ON u.id = f.user_id
       ORDER BY f.created_at DESC`
    );
    return res.json({ ok: true, data: feedbacks });
  } catch (error) {
    next(error);
  }
});

router.get("/payments", async (req, res, next) => {
  try {
    const [payments] = await pool.execute(
      `SELECT
         pr.*,
         c.name AS company_name,
         owner.name AS owner_name,
         owner.email AS owner_email,
         reviewer.name AS reviewed_by_name
       FROM payment_requests pr
       INNER JOIN companies c ON c.id = pr.company_id
       LEFT JOIN users owner ON owner.id = c.owner_user_id
       LEFT JOIN users reviewer ON reviewer.id = pr.reviewed_by
       ORDER BY
         CASE pr.status
           WHEN 'PENDING' THEN 0
           WHEN 'REJECTED' THEN 1
           ELSE 2
         END,
         pr.created_at DESC`
    );

    return res.json({ ok: true, data: payments });
  } catch (error) {
    next(error);
  }
});

router.patch(
  "/payments/:id/approve",
  [body("admin_notes").optional().trim()],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const paymentRequestId = Number(req.params.id);
      const [[paymentRequest]] = await conn.execute(
        "SELECT * FROM payment_requests WHERE id = ? FOR UPDATE",
        [paymentRequestId]
      );

      if (!paymentRequest) {
        await conn.rollback();
        return res.status(404).json({ ok: false, error: "Payment request not found" });
      }

      if (paymentRequest.status !== "PENDING") {
        await conn.rollback();
        return res.status(409).json({ ok: false, error: "Only pending payment requests can be approved" });
      }

      const adminNotes = req.body.admin_notes || "Payment approved by platform admin.";
      const { subEndsAt } = await activateSubscription(conn, {
        companyId: paymentRequest.company_id,
        plan: paymentRequest.plan,
        changedBy: req.authUserId || req.user.member_id,
        notes: `Approved payment request #${paymentRequest.id}. ${adminNotes}`,
      });

      await conn.execute(
        `UPDATE payment_requests
         SET status = 'APPROVED', admin_notes = ?, reviewed_by = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [adminNotes, req.authUserId || req.user.member_id, paymentRequestId]
      );

      await logActivity(conn, {
        userId: req.authUserId || req.user.member_id,
        type: "PAYMENT_REQUEST_APPROVED",
        description: `Payment request #${paymentRequest.id} approved.`,
        metadata: {
          changedBy: req.authUserId || req.user.member_id,
          companyId: paymentRequest.company_id,
          plan: paymentRequest.plan,
          subEndsAt,
        },
      });

      await conn.commit();

      return res.json({
        ok: true,
        message: "Payment approved and subscription activated.",
        data: { id: paymentRequestId, status: "APPROVED", sub_ends_at: subEndsAt },
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
  "/payments/:id/reject",
  [body("admin_notes").trim().notEmpty().withMessage("Rejection reason is required")],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const paymentRequestId = Number(req.params.id);
      const [[paymentRequest]] = await conn.execute(
        "SELECT * FROM payment_requests WHERE id = ? FOR UPDATE",
        [paymentRequestId]
      );

      if (!paymentRequest) {
        await conn.rollback();
        return res.status(404).json({ ok: false, error: "Payment request not found" });
      }

      if (paymentRequest.status !== "PENDING") {
        await conn.rollback();
        return res.status(409).json({ ok: false, error: "Only pending payment requests can be rejected" });
      }

      await conn.execute(
        `UPDATE payment_requests
         SET status = 'REJECTED', admin_notes = ?, reviewed_by = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [req.body.admin_notes.trim(), req.authUserId || req.user.member_id, paymentRequestId]
      );

      await logActivity(conn, {
        userId: req.authUserId || req.user.member_id,
        type: "PAYMENT_REQUEST_REJECTED",
        description: `Payment request #${paymentRequest.id} rejected.`,
        metadata: {
          changedBy: req.authUserId || req.user.member_id,
          companyId: paymentRequest.company_id,
          reason: req.body.admin_notes.trim(),
        },
      });

      await conn.commit();

      return res.json({
        ok: true,
        message: "Payment request rejected.",
        data: { id: paymentRequestId, status: "REJECTED" },
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
  "/payment-details",
  [
    body("upi_id").optional({ checkFalsy: true }).trim(),
    body("upi_mobile")
      .optional({ checkFalsy: true })
      .trim()
      .matches(/^\+\d{1,3}\s?\d{10}$/)
      .withMessage("UPI Mobile must include a country code (e.g., +91) and 10 digits"),
  ],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();
      const { upi_id, upi_mobile } = req.body;
      const userId = req.authUserId || req.user.member_id;

      if (upi_id !== undefined) {
        await conn.execute(
          `INSERT INTO platform_settings (setting_key, setting_value, updated_by)
           VALUES ('payment_upi_id', ?, ?)
           ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
          [upi_id, userId]
        );
      }

      if (upi_mobile !== undefined) {
        await conn.execute(
          `INSERT INTO platform_settings (setting_key, setting_value, updated_by)
           VALUES ('payment_upi_mobile', ?, ?)
           ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
          [upi_mobile, userId]
        );
      }

      await logActivity(conn, {
        userId,
        type: "PAYMENT_DETAILS_UPDATED",
        description: "Payment UPI details updated by platform admin.",
      });

      await conn.commit();
      return res.json({ ok: true, message: "Payment details updated successfully." });
    } catch (error) {
      await conn.rollback();
      next(error);
    } finally {
      conn.release();
    }
  }
);




router.post(
  "/payment-qr",
  qrUpload.single("qr_image"),
  async (req, res, next) => {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No QR code image uploaded" });
    }

    const conn = await pool.getConnection();
    const newPath = `/uploads/platform/${req.file.filename}`;

    try {
      await conn.beginTransaction();

      
      const [[oldSetting]] = await conn.execute(
        "SELECT setting_value FROM platform_settings WHERE setting_key = 'payment_qr_image'"
      );

      if (oldSetting?.setting_value) {
        const uploadsRoot = path.resolve(path.join(__dirname, "../uploads"));
        const oldAbsPath = path.resolve(
          path.join(__dirname, "..", oldSetting.setting_value.replace(/^\/+/, ""))
        );
        if (oldAbsPath.startsWith(uploadsRoot) && fs.existsSync(oldAbsPath)) {
          fs.unlinkSync(oldAbsPath);
        }
      }

      
      await conn.execute(
        `INSERT INTO platform_settings (setting_key, setting_value, updated_by)
         VALUES ('payment_qr_image', ?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
        [newPath, req.authUserId || req.user.member_id]
      );

      await logActivity(conn, {
        userId: req.authUserId || req.user.member_id,
        type: "PAYMENT_QR_UPLOADED",
        description: "Payment QR code image updated by platform admin.",
        metadata: { path: newPath },
      });

      await conn.commit();

      return res.json({
        ok: true,
        message: "Payment QR code uploaded successfully.",
        data: { qr_image_url: newPath },
      });
    } catch (error) {
      await conn.rollback();
      
      const absNewPath = path.join(__dirname, "..", newPath.replace(/^\/+/, ""));
      if (fs.existsSync(absNewPath)) fs.unlinkSync(absNewPath);
      next(error);
    } finally {
      conn.release();
    }
  }
);


router.delete("/payment-qr", async (req, res, next) => {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [[oldSetting]] = await conn.execute(
      "SELECT setting_value FROM platform_settings WHERE setting_key = 'payment_qr_image'"
    );

    if (oldSetting?.setting_value) {
      const uploadsRoot = path.resolve(path.join(__dirname, "../uploads"));
      const oldAbsPath = path.resolve(
        path.join(__dirname, "..", oldSetting.setting_value.replace(/^\/+/, ""))
      );
      if (oldAbsPath.startsWith(uploadsRoot) && fs.existsSync(oldAbsPath)) {
        fs.unlinkSync(oldAbsPath);
      }
    }

    await conn.execute(
      "DELETE FROM platform_settings WHERE setting_key = 'payment_qr_image'"
    );

    await logActivity(conn, {
      userId: req.authUserId || req.user.member_id,
      type: "PAYMENT_QR_DELETED",
      description: "Payment QR code image removed by platform admin.",
    });

    await conn.commit();

    return res.json({
      ok: true,
      message: "Payment QR code removed.",
    });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

module.exports = router;
