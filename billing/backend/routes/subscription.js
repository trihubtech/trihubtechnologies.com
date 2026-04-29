const router = require("express").Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { body, validationResult } = require("express-validator");
const { pool, logActivity } = require("../config/db");
const { requireAuthAllowExpired } = require("../middleware/auth");
const { PLAN_PRICES, getPlanAmount, syncSubscriptionStatus } = require("../utils/subscriptions");
const { loadCompanyProfile } = require("../utils/tenancy");

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ ok: false, error: "Validation failed", details: errors.mapped() });
  }
  return null;
}

const paymentUploadsDir = path.join(__dirname, "../uploads/payments");

function ensurePaymentsDir() {
  if (!fs.existsSync(paymentUploadsDir)) {
    fs.mkdirSync(paymentUploadsDir, { recursive: true });
  }
}

const screenshotStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensurePaymentsDir();
    cb(null, paymentUploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `payment_${req.user.company_id}_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage: screenshotStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp|pdf)$/i;
    if (!allowed.test(path.extname(file.originalname))) {
      cb(new Error("Only image or PDF proof files are allowed"));
      return;
    }

    cb(null, true);
  },
});

function cleanOptional(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function removeStoredFile(relativePath) {
  if (!relativePath) return;

  const uploadsRoot = path.resolve(path.join(__dirname, "../uploads"));
  const absolutePath = path.resolve(path.join(__dirname, "..", relativePath.replace(/^\/+/, "")));
  if (absolutePath.startsWith(uploadsRoot) && fs.existsSync(absolutePath)) {
    fs.unlinkSync(absolutePath);
  }
}

async function loadSubscriptionStatus(executor, companyId) {
  const [[companyRecord]] = await executor.execute(
    `SELECT
       c.id,
       c.subscription_plan,
       c.subscription_status,
       c.trial_ends_at,
       c.subscription_ends_at
     FROM companies c
     WHERE c.id = ?`,
    [companyId]
  );

  if (!companyRecord) {
    const error = new Error("Company not found");
    error.status = 404;
    throw error;
  }

  await syncSubscriptionStatus(executor, companyRecord);

  const company = await loadCompanyProfile(executor, companyId);

  const [[latestPaymentRequest]] = await executor.execute(
    `SELECT pr.*, reviewer.name AS reviewed_by_name
     FROM payment_requests pr
     LEFT JOIN users reviewer ON reviewer.id = pr.reviewed_by
     WHERE pr.company_id = ?
     ORDER BY pr.created_at DESC
     LIMIT 1`,
    [companyId]
  );

  return {
    company,
    latest_payment_request: latestPaymentRequest || null,
    prices: PLAN_PRICES,
  };
}

router.use(requireAuthAllowExpired);

router.get("/status", async (req, res, next) => {
  try {
    if (req.user.is_platform_admin) {
      return res.json({
        ok: true,
        user: {
          id: req.authUserId || req.user.member_id,
          is_platform_admin: 1,
        },
        company: null,
        latest_payment_request: null,
        prices: PLAN_PRICES,
      });
    }

    const status = await loadSubscriptionStatus(pool, req.user.company_id);
    return res.json({
      ok: true,
      user: {
        id: req.authUserId || req.user.member_id,
        sub_plan: status.company?.sub_plan,
        sub_status: status.company?.sub_status,
        trial_ends_at: status.company?.trial_ends_at,
        sub_ends_at: status.company?.sub_ends_at,
      },
      ...status,
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/payment-request",
  upload.single("screenshot"),
  [
    body("plan").isIn(["MONTHLY", "YEARLY"]).withMessage("Plan must be MONTHLY or YEARLY"),
    body("payment_mode").isIn(["UPI", "CASH"]).withMessage("Payment mode must be UPI or CASH"),
    body("upi_ref").optional({ checkFalsy: true }).trim(),
    body("payer_contact").optional({ checkFalsy: true }).trim(),
  ],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) {
      if (req.file) removeStoredFile(`/uploads/payments/${req.file.filename}`);
      return;
    }

    const conn = await pool.getConnection();
    const screenshotPath = req.file ? `/uploads/payments/${req.file.filename}` : null;

    try {
      await conn.beginTransaction();

      const plan = req.body.plan;
      const paymentMode = req.body.payment_mode;
      const upiRef = cleanOptional(req.body.upi_ref);
      const payerContact = cleanOptional(req.body.payer_contact);
      const amount = getPlanAmount(plan);

      if (!amount) {
        await conn.rollback();
        if (screenshotPath) removeStoredFile(screenshotPath);
        return res.status(400).json({ ok: false, error: "Unknown subscription plan" });
      }

      if (paymentMode === "UPI" && !upiRef) {
        await conn.rollback();
        if (screenshotPath) removeStoredFile(screenshotPath);
        return res.status(422).json({
          ok: false,
          error: "UPI transaction ID is required for UPI payments",
        });
      }

      const [result] = await conn.execute(
        `INSERT INTO payment_requests (
           company_id, user_id, plan, amount, payment_mode, payer_contact, upi_ref, screenshot_path
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.company_id, req.authUserId || req.user.member_id, plan, amount, paymentMode, payerContact, upiRef, screenshotPath]
      );

      await logActivity(conn, {
        userId: req.authUserId || req.user.member_id,
        type: "PAYMENT_REQUEST_SUBMITTED",
        description: `Subscription payment request #${result.insertId} submitted.`,
        metadata: { plan, paymentMode, amount },
      });

      await conn.commit();

      const status = await loadSubscriptionStatus(pool, req.user.company_id);
      return res.status(201).json({
        ok: true,
        message: "Payment submitted. Our team will verify and activate your account within 24 hours.",
        payment_request_id: result.insertId,
        user: {
          id: req.authUserId || req.user.member_id,
          sub_plan: status.company?.sub_plan,
          sub_status: status.company?.sub_status,
          trial_ends_at: status.company?.trial_ends_at,
          sub_ends_at: status.company?.sub_ends_at,
        },
        ...status,
      });
    } catch (error) {
      await conn.rollback();
      if (screenshotPath) {
        removeStoredFile(screenshotPath);
      }
      next(error);
    } finally {
      conn.release();
    }
  }
);

router.post(
  "/feedback",
  [
    body("rating").isInt({ min: 1, max: 5 }).withMessage("Rating must be between 1 and 5"),
    body("comment").optional({ checkFalsy: true }).trim()
  ],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    try {
      const { rating, comment } = req.body;
      const userId = req.authUserId || req.user.member_id;
      const companyId = req.user.company_id;

      await pool.execute(
        `INSERT INTO company_feedbacks (company_id, user_id, rating, comment) VALUES (?, ?, ?, ?)`,
        [companyId, userId, rating, cleanOptional(comment)]
      );

      return res.status(201).json({ ok: true, message: "Feedback submitted successfully." });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
