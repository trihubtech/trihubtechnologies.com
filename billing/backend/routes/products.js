const router = require("express").Router();
const { pool, getNextCode, logActivity } = require("../config/db");
const { body, param, query, validationResult } = require("express-validator");
const { requirePermission } = require("../middleware/permissions");
const { isValidGstRate } = require("../utils/gst");
const { ensureProductSchemaCompatibility } = require("../utils/productSchema");

const PRODUCT_TYPE_OPTIONS = [
  "TRADING_GOODS",
  "MANUFACTURED_GOODS",
  "JOB_WORK_PROCESSING_SERVICE",
  "SERVICES_OTHER",
];

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ ok: false, error: "Validation failed", details: errors.mapped() });
  }
  return null;
}

/**
 * Generate a unique EAN-13-style barcode (13 digits, starts with 9).
 * Format: 9 + 7-digit timestamp suffix + 4-digit random + check digit.
 * We verify uniqueness against the DB before returning.
 */
async function generateUniqueBarcode(conn) {
  const MAX_ATTEMPTS = 10;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const tsPart = String(Date.now()).slice(-7);
    const randPart = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    const raw = `9${tsPart}${randPart}`; // 12 digits
    const checkDigit = calcEAN13Check(raw);
    const barcode = `${raw}${checkDigit}`;

    const [[existing]] = await conn.execute(
      "SELECT id FROM products WHERE barcode = ? LIMIT 1",
      [barcode]
    );
    if (!existing) return barcode;
  }
  throw new Error("Could not generate a unique barcode — please retry.");
}

function calcEAN13Check(twelveDigits) {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(twelveDigits[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  return String((10 - (sum % 10)) % 10);
}

const productValidation = [
  body("name").trim().notEmpty().withMessage("Name is required"),
  body("product_type").isIn(PRODUCT_TYPE_OPTIONS).withMessage("Product type is required"),
  body("hsn_sac_code").optional({ checkFalsy: true }).trim(),
  body("category").trim().notEmpty().withMessage("Category is required"),
  body("unit").trim().notEmpty().withMessage("Unit is required"),
  body("mrp").isFloat({ min: 0 }).withMessage("MRP must be non-negative"),
  body("price").isFloat({ min: 0 }).withMessage("Price must be non-negative"),
  body("tax_rate")
    .custom((value) => isValidGstRate(value))
    .withMessage("GST rate must be a valid percentage between 0 and 100, with up to 3 decimal places"),
  body("product_tag").optional({ checkFalsy: true }).trim(),
];

/* ── GET /products?page&pageSize&search&category&active ──────────────── */
router.get(
  "/",
  requirePermission("can_list_products"),
  [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("pageSize").optional().isInt({ min: 1, max: 500 }).toInt(),
    query("search").optional().trim(),
    query("category").optional().trim(),
    query("active").optional().isIn(["0", "1"]),
  ],
  async (req, res, next) => {
    try {
      await ensureProductSchemaCompatibility(pool);
      const page = req.query.page || 1;
      const pageSize = req.query.pageSize || 20;
      const offset = (page - 1) * pageSize;
      const search = req.query.search || "";
      const category = req.query.category || null;
      const active = req.query.active ?? "1";

      const where = ["p.user_id = ?", "p.is_active = ?"];
      const params = [req.user.id, active];

      if (search) {
        const like = `%${search}%`;
        where.push("(p.code LIKE ? OR p.name LIKE ? OR p.category LIKE ? OR p.barcode LIKE ?)");
        params.push(like, like, like, like);
      }

      if (category) {
        where.push("p.category = ?");
        params.push(category);
      }

      const whereClause = where.join(" AND ");
      const stockParams = [req.user.id, ...params];

      const [rows] = await pool.execute(
        `SELECT p.*,
           COALESCE((
             SELECT new_qty
             FROM inventory
             WHERE product_id = p.id AND user_id = ?
             ORDER BY id DESC
             LIMIT 1
           ), 0) AS current_stock
         FROM products p
         WHERE ${whereClause}
         ORDER BY p.name
         LIMIT ${parseInt(pageSize, 10)} OFFSET ${parseInt(offset, 10)}`,
        stockParams
      );

      const [[countRow]] = await pool.execute(
        `SELECT COUNT(*) AS total FROM products p WHERE ${whereClause}`,
        params
      );

      const [categories] = await pool.execute(
        "SELECT DISTINCT category FROM products WHERE user_id = ? AND is_active = 1 ORDER BY category",
        [req.user.id]
      );

      return res.json({
        ok: true,
        data: rows,
        total: countRow.total,
        page,
        pageSize,
        totalPages: Math.ceil(countRow.total / pageSize),
        categories: categories.map((item) => item.category),
      });
    } catch (error) {
      next(error);
    }
  }
);

/* ── GET /products/barcode/:barcode  (barcode lookup for scanner) ─────── */
router.get(
  "/barcode/:barcode",
  requirePermission("can_list_products"),
  [param("barcode").trim().notEmpty()],
  async (req, res, next) => {
    try {
      await ensureProductSchemaCompatibility(pool);
      const [[product]] = await pool.execute(
        `SELECT p.*,
           COALESCE((
             SELECT new_qty
             FROM inventory
             WHERE product_id = p.id AND user_id = ?
             ORDER BY id DESC
             LIMIT 1
           ), 0) AS current_stock
         FROM products p
         WHERE p.barcode = ? AND p.user_id = ? AND p.is_active = 1`,
        [req.user.id, req.params.barcode, req.user.id]
      );

      if (!product) {
        return res.status(404).json({ ok: false, error: "Product not found for this barcode" });
      }

      return res.json({ ok: true, data: product });
    } catch (error) {
      next(error);
    }
  }
);

/* ── GET /products/:id ───────────────────────────────────────────────── */
router.get("/:id", requirePermission("can_view_products"), [param("id").isInt().toInt()], async (req, res, next) => {
  try {
    await ensureProductSchemaCompatibility(pool);
    const [[product]] = await pool.execute(
      `SELECT p.*,
         COALESCE((
           SELECT new_qty
           FROM inventory
           WHERE product_id = p.id AND user_id = ?
           ORDER BY id DESC
           LIMIT 1
         ), 0) AS current_stock
       FROM products p
       WHERE p.id = ? AND p.user_id = ?`,
      [req.user.id, req.params.id, req.user.id]
    );

    if (!product) {
      return res.status(404).json({ ok: false, error: "Product not found" });
    }

    return res.json({ ok: true, data: product });
  } catch (error) {
    next(error);
  }
});

/* ── POST /products ──────────────────────────────────────────────────── */
router.post("/", requirePermission("can_add_products"), productValidation, async (req, res, next) => {
  const err = validationErrors(req, res);
  if (err) return;

  const conn = await pool.getConnection();
  try {
    await ensureProductSchemaCompatibility(conn);
    await conn.beginTransaction();

    const { name, product_type, hsn_sac_code, category, product_tag, unit, mrp, price, description, tax_rate = 0 } = req.body;
    const normalizedHsnSacCode = product_type === "JOB_WORK_PROCESSING_SERVICE"
      ? "9988"
      : String(hsn_sac_code || "").trim().toUpperCase();
    const code = await getNextCode(conn, "PRODUCT");
    const barcode = await generateUniqueBarcode(conn);

    const [result] = await conn.execute(
      `INSERT INTO products (user_id, code, barcode, name, hsn_sac_code, product_type, category, product_tag, unit, mrp, price, description, tax_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, code, barcode, name, normalizedHsnSacCode, product_type, category, product_tag || null, unit, mrp, price, description || null, tax_rate]
    );

    await logActivity(conn, {
      userId: req.user.id,
      type: "PRODUCT_CREATED",
      entityId: result.insertId,
      entityCode: code,
      description: `Product created: ${name} (${code})`,
    });

    await conn.commit();

    const [[product]] = await pool.execute(
      "SELECT * FROM products WHERE id = ? AND user_id = ?",
      [result.insertId, req.user.id]
    );

    return res.status(201).json({ ok: true, data: product, message: "Product created successfully" });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

/* ── PUT /products/:id ───────────────────────────────────────────────── */
router.put("/:id", requirePermission("can_edit_products"), [param("id").isInt().toInt(), ...productValidation], async (req, res, next) => {
  const err = validationErrors(req, res);
  if (err) return;

  const conn = await pool.getConnection();
  try {
    await ensureProductSchemaCompatibility(conn);
    await conn.beginTransaction();

    const [[existing]] = await conn.execute(
      "SELECT * FROM products WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );

    if (!existing) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "Product not found" });
    }

    // Back-fill barcode for legacy products that have none yet
    let barcode = existing.barcode;
    if (!barcode) {
      barcode = await generateUniqueBarcode(conn);
    }

    const { name, product_type, hsn_sac_code, category, product_tag, unit, mrp, price, description, tax_rate = 0 } = req.body;
    const normalizedHsnSacCode = product_type === "JOB_WORK_PROCESSING_SERVICE"
      ? "9988"
      : String(hsn_sac_code || "").trim().toUpperCase();

    await conn.execute(
      `UPDATE products
       SET name = ?, hsn_sac_code = ?, product_type = ?, category = ?, product_tag = ?, unit = ?, mrp = ?, price = ?, description = ?, tax_rate = ?, barcode = ?
       WHERE id = ? AND user_id = ?`,
      [name, normalizedHsnSacCode, product_type, category, product_tag || null, unit, mrp, price, description || null, tax_rate, barcode, req.params.id, req.user.id]
    );

    await conn.commit();
    return res.json({ ok: true, message: "Product updated successfully" });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

/* ── DELETE /products/:id ────────────────────────────────────────────── */
router.delete("/:id", requirePermission("can_delete_products"), [param("id").isInt().toInt()], async (req, res, next) => {
  try {
    await ensureProductSchemaCompatibility(pool);
    const [[existing]] = await pool.execute(
      "SELECT * FROM products WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );

    if (!existing) {
      return res.status(404).json({ ok: false, error: "Product not found" });
    }

    const [[invoiceUse]] = await pool.execute(
      "SELECT COUNT(*) AS cnt FROM invoice_items WHERE product_id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    const [[billUse]] = await pool.execute(
      "SELECT COUNT(*) AS cnt FROM bill_items WHERE product_id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );

    await pool.execute(
      "UPDATE products SET is_active = 0 WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );

    if (invoiceUse.cnt > 0 || billUse.cnt > 0) {
      return res.json({ ok: true, message: "Product deactivated (used in existing records)" });
    }

    return res.json({ ok: true, message: "Product deleted successfully" });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
