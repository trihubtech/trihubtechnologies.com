const router = require("express").Router();
const { pool, getNextCode, logActivity } = require("../config/db");
const { body, param, query, validationResult } = require("express-validator");
const { requirePermission } = require("../middleware/permissions");

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ ok: false, error: "Validation failed", details: errors.mapped() });
  }
  return null;
}

const productValidation = [
  body("name").trim().notEmpty().withMessage("Name is required"),
  body("category").trim().notEmpty().withMessage("Category is required"),
  body("unit").trim().notEmpty().withMessage("Unit is required"),
  body("mrp").isFloat({ min: 0 }).withMessage("MRP must be non-negative"),
  body("price").isFloat({ min: 0 }).withMessage("Price must be non-negative"),
  body("tax_rate").optional().isFloat({ min: 0, max: 100 }).withMessage("Tax rate must be 0-100"),
];

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
        where.push("(p.code LIKE ? OR p.name LIKE ? OR p.category LIKE ?)");
        params.push(like, like, like);
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

router.get("/:id", requirePermission("can_view_products"), [param("id").isInt().toInt()], async (req, res, next) => {
  try {
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

router.post("/", requirePermission("can_add_products"), productValidation, async (req, res, next) => {
  const err = validationErrors(req, res);
  if (err) return;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const { name, category, unit, mrp, price, description, tax_rate = 0 } = req.body;
    const code = await getNextCode(conn, "PRODUCT");

    const [result] = await conn.execute(
      `INSERT INTO products (user_id, code, name, category, unit, mrp, price, description, tax_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, code, name, category, unit, mrp, price, description || null, tax_rate]
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

router.put("/:id", requirePermission("can_edit_products"), [param("id").isInt().toInt(), ...productValidation], async (req, res, next) => {
  const err = validationErrors(req, res);
  if (err) return;

  try {
    const [[existing]] = await pool.execute(
      "SELECT * FROM products WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );

    if (!existing) {
      return res.status(404).json({ ok: false, error: "Product not found" });
    }

    const { name, category, unit, mrp, price, description, tax_rate = 0 } = req.body;

    await pool.execute(
      `UPDATE products
       SET name = ?, category = ?, unit = ?, mrp = ?, price = ?, description = ?, tax_rate = ?
       WHERE id = ? AND user_id = ?`,
      [name, category, unit, mrp, price, description || null, tax_rate, req.params.id, req.user.id]
    );

    return res.json({ ok: true, message: "Product updated successfully" });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", requirePermission("can_delete_products"), [param("id").isInt().toInt()], async (req, res, next) => {
  try {
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
