const router = require("express").Router();
const { pool, getNextCode, adjustStock, logActivity } = require("../config/db");
const { body, query, validationResult } = require("express-validator");
const { requirePermission } = require("../middleware/permissions");

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ ok: false, error: "Validation failed", details: errors.mapped() });
  }
  return null;
}

router.get(
  "/",
  requirePermission("can_list_inventory"),
  [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("pageSize").optional().isInt({ min: 1, max: 200 }).toInt(),
    query("search").optional().trim(),
    query("product_id").optional().isInt().toInt(),
    query("type").optional().isIn(["MANUAL", "SALE", "SALE_RETURN", "PURCHASE", "PURCHASE_RETURN"]),
  ],
  async (req, res, next) => {
    try {
      const page = req.query.page || 1;
      const pageSize = req.query.pageSize || 20;
      const offset = (page - 1) * pageSize;
      const search = req.query.search || "";
      const productId = req.query.product_id || null;
      const type = req.query.type || null;

      const where = ["inv.user_id = ?", "p.user_id = ?"];
      const params = [req.user.id, req.user.id];

      if (search) {
        const like = `%${search}%`;
        where.push("(inv.code LIKE ? OR inv.reason LIKE ? OR p.name LIKE ?)");
        params.push(like, like, like);
      }
      if (productId) {
        where.push("inv.product_id = ?");
        params.push(productId);
      }
      if (type) {
        where.push("inv.type = ?");
        params.push(type);
      }

      const whereClause = where.join(" AND ");

      const [rows] = await pool.execute(
        `SELECT inv.*, p.code AS product_code, p.name AS product_name, p.unit AS product_unit
         FROM inventory inv
         JOIN products p ON p.id = inv.product_id
         WHERE ${whereClause}
         ORDER BY inv.id DESC
         LIMIT ${parseInt(pageSize, 10)} OFFSET ${parseInt(offset, 10)}`,
        params
      );

      const [[countRow]] = await pool.execute(
        `SELECT COUNT(*) AS total
         FROM inventory inv
         JOIN products p ON p.id = inv.product_id
         WHERE ${whereClause}`,
        params
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

router.get("/stock-summary", requirePermission("can_view_inventory"), async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT p.id, p.code, p.name, p.unit, p.category,
         COALESCE((
           SELECT new_qty
           FROM inventory
           WHERE product_id = p.id AND user_id = ?
           ORDER BY id DESC
           LIMIT 1
         ), 0) AS current_stock
       FROM products p
       WHERE p.user_id = ? AND p.is_active = 1
       ORDER BY p.name`,
      [req.user.id, req.user.id]
    );

    return res.json({ ok: true, data: rows });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/",
  requirePermission("can_add_inventory"),
  [
    body("product_id").isInt({ min: 1 }).withMessage("Product is required"),
    body("adjustment")
      .isFloat()
      .withMessage("Adjustment value is required")
      .custom((value) => value !== 0)
      .withMessage("Adjustment cannot be zero"),
    body("reason").trim().notEmpty().withMessage("Reason is required"),
  ],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const { product_id: productId, adjustment, reason } = req.body;
      const [[product]] = await conn.execute(
        "SELECT id, name FROM products WHERE id = ? AND user_id = ? AND is_active = 1",
        [productId, req.user.id]
      );

      if (!product) {
        await conn.rollback();
        return res.status(422).json({ ok: false, error: "Product not found" });
      }

      const stockCode = await getNextCode(conn, "INVENTORY");
      await adjustStock(conn, {
        userId: req.user.id,
        productId,
        adjustment: Number(adjustment),
        type: "MANUAL",
        reason,
        inventoryCode: stockCode,
      });

      await logActivity(conn, {
        userId: req.user.id,
        type: "INVENTORY_ADJUSTED",
        entityCode: stockCode,
        description: `Manual stock adjustment for ${product.name}: ${adjustment > 0 ? "+" : ""}${adjustment}`,
      });

      await conn.commit();
      return res.status(201).json({ ok: true, message: "Stock adjusted successfully" });
    } catch (error) {
      await conn.rollback();
      next(error);
    } finally {
      conn.release();
    }
  }
);

module.exports = router;
