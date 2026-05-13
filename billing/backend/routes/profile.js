const router = require("express").Router();
const bcrypt = require("bcryptjs");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { pool, logActivity } = require("../config/db");
const { body, query, validationResult } = require("express-validator");
const { hasPermission, loadCompanyProfile } = require("../utils/tenancy");
const { ensureCompanyProfileSchemaCompatibility } = require("../utils/companyProfileSchema");
const {
  cleanOptional: cleanOptionalGst,
  deriveStateFromGstin,
  findStateByCode,
  findStateByName,
  isIndianCountry,
  normalizeCountry,
  normalizeStateCode,
  validateGstin,
} = require("../utils/gst");

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ ok: false, error: "Validation failed", details: errors.mapped() });
  }
  return null;
}

const profileUploadsDir = path.join(__dirname, "../uploads/profiles");

function ensureProfileUploadDir() {
  if (!fs.existsSync(profileUploadsDir)) {
    fs.mkdirSync(profileUploadsDir, { recursive: true });
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureProfileUploadDir();
    cb(null, profileUploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${req.authUserId || req.user.member_id}_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp)$/i;
    const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
    if (!allowed.test(path.extname(file.originalname)) || !allowedMimeTypes.has(file.mimetype)) {
      cb(new Error("Only image files are allowed"));
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

function normalizeGstin(value) {
  const cleaned = cleanOptional(value);
  return cleaned ? cleaned.toUpperCase() : null;
}

function resolveCompanyTaxRegion(payload) {
  const country = normalizeCountry(payload.country);
  const gstin = normalizeGstin(payload.gstin);

  if (!isIndianCountry(country)) {
    if (gstin) {
      const error = new Error("GSTIN can only be used when company country is India");
      error.status = 422;
      throw error;
    }

    const stateName = cleanOptionalGst(payload.state_name);
    if (!stateName) {
      const error = new Error("State / region is required");
      error.status = 422;
      throw error;
    }

    return {
      country,
      gstin: null,
      stateName,
      stateCode: null,
    };
  }

  const stateFromCode = findStateByCode(payload.state_code);
  const stateFromName = findStateByName(payload.state_name);
  const stateFromGstin = deriveStateFromGstin(gstin);
  const state = stateFromCode || stateFromName || stateFromGstin;

  if (!state) {
    const error = new Error("State is required for companies in India");
    error.status = 422;
    throw error;
  }

  if (stateFromGstin && stateFromGstin.code !== state.code) {
    const error = new Error("Company state must match the GSTIN state code");
    error.status = 422;
    throw error;
  }

  return {
    country,
    gstin,
    stateName: state.name,
    stateCode: normalizeStateCode(state.code),
  };
}

function toUploadPath(fileName) {
  return `/uploads/profiles/${fileName}`;
}

function resolveUploadPath(relativePath) {
  if (!relativePath) return null;

  const uploadsRoot = path.resolve(path.join(__dirname, "../uploads"));
  const cleanedPath = relativePath.replace(/^\/+/, "");
  const absolutePath = path.resolve(path.join(__dirname, "..", cleanedPath));

  return absolutePath.startsWith(uploadsRoot) ? absolutePath : null;
}

function getStoredFileSize(relativePath) {
  const absolutePath = resolveUploadPath(relativePath);
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    return 0;
  }

  return fs.statSync(absolutePath).size;
}

function removeStoredFile(relativePath) {
  const absolutePath = resolveUploadPath(relativePath);
  if (absolutePath && fs.existsSync(absolutePath)) {
    fs.unlinkSync(absolutePath);
  }
}

function duplicateFieldMessage(error) {
  if (error?.code !== "ER_DUP_ENTRY") {
    return null;
  }

  if (String(error.message || "").includes("uq_company_gstin")) {
    return "This GST number is already registered under another company.";
  }

  if (String(error.message || "").includes("uq_company_phone")) {
    return "This phone number is already registered under another company.";
  }

  return "This company detail is already registered.";
}

const INTERNATIONAL_PHONE_REGEX = /^\+\d{1,4}\s?\d{6,14}$/;

async function ensureCompanyFieldUnique(executor, field, value, companyId, message) {
  if (!value) return;

  const [[existing]] = await executor.execute(
    `SELECT id
     FROM company_profiles
     WHERE ${field} = ? AND company_id != ?
     LIMIT 1`,
    [value, companyId]
  );

  if (existing) {
    const error = new Error(message);
    error.status = 409;
    throw error;
  }
}

async function updateStorageUsed(executor, companyId, delta) {
  if (!delta) return;

  await executor.execute(
    `UPDATE company_profiles
     SET storage_used_bytes = GREATEST(CAST(COALESCE(storage_used_bytes, 0) AS SIGNED) + ?, 0)
     WHERE company_id = ?`,
    [delta, companyId]
  );
}

function ensureCompanyManager(req, res) {
  if (req.user?.is_platform_admin || hasPermission(req.user?.permissions, "can_edit_company")) {
    return true;
  }

  res.status(403).json({ ok: false, error: "PERMISSION_DENIED", permission: "can_edit_company" });
  return false;
}

router.get("/", async (req, res, next) => {
  try {
    const [[user]] = await pool.execute(
      `SELECT id, name, email, salutation, dob, designation, mobile, profile_picture,
              role, status, is_platform_admin, email_verified_at, created_at
       FROM users
       WHERE id = ?`,
      [req.authUserId || req.user.member_id]
    );

    return res.json({ ok: true, data: user });
  } catch (err) {
    next(err);
  }
});

router.put(
  "/",
  upload.single("profile_picture"),
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("salutation").optional().trim(),
    body("dob").optional({ checkFalsy: true }).isISO8601(),
    body("designation").optional({ checkFalsy: true }).trim(),
    body("mobile")
      .optional({ checkFalsy: true })
      .trim()
      .matches(INTERNATIONAL_PHONE_REGEX)
      .withMessage("Mobile number must include a country code and 6 to 14 digits"),
  ],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    try {
      const { name, salutation, dob, designation, mobile } = req.body;
      const profilePicture = req.file ? toUploadPath(req.file.filename) : undefined;

      const setClauses = [
        "name = ?",
        "salutation = ?",
        "dob = ?",
        "designation = ?",
        "mobile = ?",
      ];
      const values = [
        name,
        salutation || "Mr.",
        dob || null,
        designation || null,
        mobile || null,
      ];

      if (profilePicture) {
        setClauses.push("profile_picture = ?");
        values.push(profilePicture);
      }

      values.push(req.authUserId || req.user.member_id);

      await pool.execute(
        `UPDATE users SET ${setClauses.join(", ")} WHERE id = ?`,
        values
      );

      const [[updatedUser]] = await pool.execute(
        `SELECT id, name, email, salutation, dob, designation, mobile, profile_picture,
                role, status, is_platform_admin, email_verified_at, created_at
         FROM users
         WHERE id = ?`,
        [req.authUserId || req.user.member_id]
      );

      return res.json({ ok: true, message: "Profile updated successfully", data: updatedUser });
    } catch (error) {
      next(error);
    }
  }
);

router.get("/company", async (req, res, next) => {
  try {
    await ensureCompanyProfileSchemaCompatibility(pool);
    if (!req.user?.is_platform_admin && !hasPermission(req.user?.permissions, "can_view_company")) {
      return res.status(403).json({ ok: false, error: "PERMISSION_DENIED", permission: "can_view_company" });
    }

    const company = await loadCompanyProfile(pool, req.user.company_id);
    return res.json({ ok: true, data: company });
  } catch (err) {
    next(err);
  }
});

router.put(
  "/company",
  upload.single("logo"),
  [
    body("name").trim().notEmpty().withMessage("Company name is required"),
    body("address").optional({ checkFalsy: true }).trim(),
    body("phone")
      .optional({ checkFalsy: true })
      .trim()
      .matches(INTERNATIONAL_PHONE_REGEX)
      .withMessage("Phone number must include a country code and 6 to 14 digits"),
    body("email").optional({ checkFalsy: true }).isEmail(),
    body("country").trim().notEmpty().withMessage("Country is required"),
    body("gstin")
      .optional({ checkFalsy: true })
      .trim()
      .custom((value) => validateGstin(value))
      .withMessage("GSTIN must be a valid 15-character value"),
    body("state_name").optional({ checkFalsy: true }).trim(),
    body("state_code").optional({ checkFalsy: true }).trim(),
    body("pan").optional({ checkFalsy: true }).trim(),
    body("website").optional({ checkFalsy: true }).trim(),
    body("bank_name").optional({ checkFalsy: true }).trim(),
    body("bank_account_number").optional({ checkFalsy: true }).trim(),
    body("bank_ifsc").optional({ checkFalsy: true }).trim(),
    body("bank_branch").optional({ checkFalsy: true }).trim(),
    body("upi_id").optional({ checkFalsy: true }).trim(),
    body("upi_name").optional({ checkFalsy: true }).trim(),
    body("terms_and_conditions").optional({ checkFalsy: true }).trim(),
  ],
  async (req, res, next) => {
    if (!ensureCompanyManager(req, res)) return;

    const err = validationErrors(req, res);
    if (err) return;

    const conn = await pool.getConnection();
    const uploadedLogoPath = req.file ? toUploadPath(req.file.filename) : null;

    try {
      await ensureCompanyProfileSchemaCompatibility(conn);
      await conn.beginTransaction();

      const existing = await loadCompanyProfile(conn, req.user.company_id);
      const { country, gstin, stateName, stateCode } = resolveCompanyTaxRegion(req.body);
      const phone = cleanOptional(req.body.phone);

      await ensureCompanyFieldUnique(
        conn,
        "gstin",
        gstin,
        req.user.company_id,
        "This GST number is already registered under another company."
      );
      await ensureCompanyFieldUnique(
        conn,
        "phone",
        phone,
        req.user.company_id,
        "This phone number is already registered under another company."
      );

      const nextLogoPath = uploadedLogoPath || existing?.logo || null;
      const storageDelta = req.file
        ? req.file.size - getStoredFileSize(existing?.logo)
        : 0;

      if (existing) {
        await conn.execute(
          `UPDATE companies SET name = ? WHERE id = ?`,
          [req.body.name.trim(), req.user.company_id]
        );

        await conn.execute(
          `UPDATE company_profiles
           SET name = ?, address = ?, phone = ?, email = ?, gstin = ?, country = ?, pan = ?, website = ?,
               bank_name = ?, bank_account_number = ?, bank_ifsc = ?, bank_branch = ?,
               state_code = ?, state_name = ?, upi_id = ?, upi_name = ?, logo = ?, terms_and_conditions = ?
           WHERE company_id = ?`,
          [
            req.body.name.trim(),
            cleanOptional(req.body.address),
            phone,
            cleanOptional(req.body.email),
            gstin,
            country,
            cleanOptional(req.body.pan),
            cleanOptional(req.body.website),
            cleanOptional(req.body.bank_name),
            cleanOptional(req.body.bank_account_number),
            cleanOptional(req.body.bank_ifsc),
            cleanOptional(req.body.bank_branch),
            stateCode,
            stateName,
            cleanOptional(req.body.upi_id),
            cleanOptional(req.body.upi_name),
            nextLogoPath,
            cleanOptional(req.body.terms_and_conditions),
            req.user.company_id,
          ]
        );

        await updateStorageUsed(conn, req.user.company_id, storageDelta);
      } else {
        await conn.execute(
          `UPDATE companies SET name = ? WHERE id = ?`,
          [req.body.name.trim(), req.user.company_id]
        );

        await conn.execute(
          `INSERT INTO company_profiles (
             company_id, user_id, name, address, phone, email, gstin, country, state_code, state_name, pan, website,
             bank_name, bank_account_number, bank_ifsc, bank_branch, upi_id, upi_name, logo, storage_used_bytes, terms_and_conditions
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.user.company_id,
            req.user.member_id,
            req.body.name.trim(),
            cleanOptional(req.body.address),
            phone,
            cleanOptional(req.body.email),
            gstin,
            country,
            stateCode,
            stateName,
            cleanOptional(req.body.pan),
            cleanOptional(req.body.website),
            cleanOptional(req.body.bank_name),
            cleanOptional(req.body.bank_account_number),
            cleanOptional(req.body.bank_ifsc),
            cleanOptional(req.body.bank_branch),
            cleanOptional(req.body.upi_id),
            cleanOptional(req.body.upi_name),
            nextLogoPath,
            req.file?.size || 0,
            cleanOptional(req.body.terms_and_conditions),
          ]
        );
      }

      await logActivity(conn, {
        userId: req.authUserId || req.user.member_id,
        type: "COMPANY_PROFILE_UPDATED",
        description: "Company profile updated.",
      });

      await conn.commit();

      if (uploadedLogoPath && existing?.logo && existing.logo !== uploadedLogoPath) {
        removeStoredFile(existing.logo);
      }

      const updatedCompany = await loadCompanyProfile(pool, req.user.company_id);
      return res.json({
        ok: true,
        message: "Company profile updated successfully",
        data: updatedCompany,
      });
    } catch (error) {
      await conn.rollback();
      if (uploadedLogoPath) {
        removeStoredFile(uploadedLogoPath);
      }

      const duplicateMessage = duplicateFieldMessage(error);
      if (duplicateMessage) {
        return res.status(409).json({ ok: false, error: duplicateMessage });
      }

      if (error.status === 409) {
        return res.status(409).json({ ok: false, error: error.message });
      }

      next(error);
    } finally {
      conn.release();
    }
  }
);

router.post("/company/upi-qr", upload.single("upi_qr_image"), async (req, res, next) => {
  if (!ensureCompanyManager(req, res)) return;

  if (!req.file) {
    return res.status(400).json({ ok: false, error: "UPI QR image is required" });
  }

  const conn = await pool.getConnection();
  const uploadedQrPath = toUploadPath(req.file.filename);

  try {
    await ensureCompanyProfileSchemaCompatibility(conn);
    await conn.beginTransaction();

    const existing = await loadCompanyProfile(conn, req.user.company_id);
    if (!existing) {
      await conn.rollback();
      removeStoredFile(uploadedQrPath);
      return res.status(404).json({ ok: false, error: "Company profile not found" });
    }

    const storageDelta = req.file.size - getStoredFileSize(existing.upi_qr_image);

    await conn.execute(
      "UPDATE company_profiles SET upi_qr_image = ? WHERE company_id = ?",
      [uploadedQrPath, req.user.company_id]
    );
    await updateStorageUsed(conn, req.user.company_id, storageDelta);

    await logActivity(conn, {
      userId: req.authUserId || req.user.member_id,
      type: "COMPANY_UPI_QR_UPDATED",
      description: "Company UPI QR image updated.",
    });

    await conn.commit();

    if (existing.upi_qr_image && existing.upi_qr_image !== uploadedQrPath) {
      removeStoredFile(existing.upi_qr_image);
    }

    const updatedCompany = await loadCompanyProfile(pool, req.user.company_id);
    return res.json({
      ok: true,
      message: "UPI QR image uploaded successfully",
      data: updatedCompany,
    });
  } catch (error) {
    await conn.rollback();
    removeStoredFile(uploadedQrPath);
    next(error);
  } finally {
    conn.release();
  }
});

router.delete("/company/upi-qr", async (req, res, next) => {
  if (!ensureCompanyManager(req, res)) return;

  const conn = await pool.getConnection();

  try {
    await ensureCompanyProfileSchemaCompatibility(conn);
    await conn.beginTransaction();

    const existing = await loadCompanyProfile(conn, req.user.company_id);
    if (!existing?.upi_qr_image) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "No uploaded UPI QR image found" });
    }

    const previousPath = existing.upi_qr_image;
    const storageDelta = -getStoredFileSize(previousPath);

    await conn.execute(
      "UPDATE company_profiles SET upi_qr_image = NULL WHERE company_id = ?",
      [req.user.company_id]
    );
    await updateStorageUsed(conn, req.user.company_id, storageDelta);

    await logActivity(conn, {
      userId: req.authUserId || req.user.member_id,
      type: "COMPANY_UPI_QR_REMOVED",
      description: "Company UPI QR image removed.",
    });

    await conn.commit();

    removeStoredFile(previousPath);

    const updatedCompany = await loadCompanyProfile(pool, req.user.company_id);
    return res.json({
      ok: true,
      message: "UPI QR image removed successfully",
      data: updatedCompany,
    });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

router.post("/company/signature", upload.single("authorized_signature"), async (req, res, next) => {
  if (!ensureCompanyManager(req, res)) return;

  if (!req.file) {
    return res.status(400).json({ ok: false, error: "Authorised signature image is required" });
  }

  const conn = await pool.getConnection();
  const uploadedSignaturePath = toUploadPath(req.file.filename);

  try {
    await ensureCompanyProfileSchemaCompatibility(conn);
    await conn.beginTransaction();

    const existing = await loadCompanyProfile(conn, req.user.company_id);
    if (!existing) {
      await conn.rollback();
      removeStoredFile(uploadedSignaturePath);
      return res.status(404).json({ ok: false, error: "Company profile not found" });
    }

    const storageDelta = req.file.size - getStoredFileSize(existing.authorized_signature);

    await conn.execute(
      "UPDATE company_profiles SET authorized_signature = ? WHERE company_id = ?",
      [uploadedSignaturePath, req.user.company_id]
    );
    await updateStorageUsed(conn, req.user.company_id, storageDelta);

    await logActivity(conn, {
      userId: req.authUserId || req.user.member_id,
      type: "COMPANY_SIGNATURE_UPDATED",
      description: "Company authorised signature image updated.",
    });

    await conn.commit();

    if (existing.authorized_signature && existing.authorized_signature !== uploadedSignaturePath) {
      removeStoredFile(existing.authorized_signature);
    }

    const updatedCompany = await loadCompanyProfile(pool, req.user.company_id);
    return res.json({
      ok: true,
      message: "Authorised signature uploaded successfully",
      data: updatedCompany,
    });
  } catch (error) {
    await conn.rollback();
    removeStoredFile(uploadedSignaturePath);
    next(error);
  } finally {
    conn.release();
  }
});

router.delete("/company/signature", async (req, res, next) => {
  if (!ensureCompanyManager(req, res)) return;

  const conn = await pool.getConnection();

  try {
    await ensureCompanyProfileSchemaCompatibility(conn);
    await conn.beginTransaction();

    const existing = await loadCompanyProfile(conn, req.user.company_id);
    if (!existing?.authorized_signature) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "No uploaded authorised signature image found" });
    }

    const previousPath = existing.authorized_signature;
    const storageDelta = -getStoredFileSize(previousPath);

    await conn.execute(
      "UPDATE company_profiles SET authorized_signature = NULL WHERE company_id = ?",
      [req.user.company_id]
    );
    await updateStorageUsed(conn, req.user.company_id, storageDelta);

    await logActivity(conn, {
      userId: req.authUserId || req.user.member_id,
      type: "COMPANY_SIGNATURE_REMOVED",
      description: "Company authorised signature image removed.",
    });

    await conn.commit();

    removeStoredFile(previousPath);

    const updatedCompany = await loadCompanyProfile(pool, req.user.company_id);
    return res.json({
      ok: true,
      message: "Authorised signature removed successfully",
      data: updatedCompany,
    });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

router.put(
  "/password",
  [
    body("current_password").notEmpty().withMessage("Current password is required"),
    body("new_password")
      .isStrongPassword({
        minLength: 8,
        minLowercase: 1,
        minUppercase: 1,
        minNumbers: 1,
        minSymbols: 1,
      })
      .withMessage("Password must be at least 8 characters and include uppercase, lowercase, number, and special character"),
    body("confirm_password")
      .custom((value, { req }) => value === req.body.new_password)
      .withMessage("Passwords do not match"),
  ],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    try {
      const { current_password: currentPassword, new_password: newPassword } = req.body;

      const [[user]] = await pool.execute(
        "SELECT password_hash FROM users WHERE id = ?",
        [req.authUserId || req.user.member_id]
      );

      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) {
        return res.status(400).json({ ok: false, error: "Current password is incorrect" });
      }

      const newHash = await bcrypt.hash(newPassword, 12);
      await pool.execute("UPDATE users SET password_hash = ?, password_set_at = NOW(), must_change_password = 0 WHERE id = ?", [
        newHash,
        req.authUserId || req.user.member_id,
      ]);

      return res.json({ ok: true, message: "Password changed successfully" });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/activities",
  [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("pageSize").optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  async (req, res, next) => {
    try {
      const page = req.query.page || 1;
      const pageSize = req.query.pageSize || 20;
      const offset = (page - 1) * pageSize;

      const [rows] = await pool.execute(
        `SELECT *
         FROM activities
         WHERE user_id = ?
         ORDER BY id DESC
         LIMIT ${parseInt(pageSize, 10)} OFFSET ${parseInt(offset, 10)}`,
        [req.authUserId || req.user.member_id]
      );

      const [[countRow]] = await pool.execute(
        "SELECT COUNT(*) AS total FROM activities WHERE user_id = ?",
        [req.authUserId || req.user.member_id]
      );

      return res.json({
        ok: true,
        data: rows,
        total: countRow.total,
        page,
        pageSize,
        totalPages: Math.ceil(countRow.total / pageSize),
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
