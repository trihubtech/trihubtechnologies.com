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

const customerValidation = [
  body("salutation").trim().notEmpty().withMessage("Salutation is required"),
  body("name").trim().notEmpty().withMessage("Name is required"),
  body("mobile")
    .trim()
    .notEmpty()
    .withMessage("Mobile is required")
    .matches(/^\+\d{1,3}\s?\d{10}$/)
    .withMessage("Mobile number must include a country code (e.g., +91) and 10 digits"),
  body("address").trim().notEmpty().withMessage("Address is required"),
  body("email").optional({ checkFalsy: true }).isEmail().withMessage("Invalid email"),
  body("gstin").optional({ checkFalsy: true }).trim(),
];

router.get(
  "/",
  requirePermission("can_list_customers"),
  [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("pageSize").optional().isInt({ min: 1, max: 500 }).toInt(),
    query("search").optional().trim(),
    query("active").optional().isIn(["0", "1"]),
  ],
  async (req, res, next) => {
    try {
      const page = req.query.page || 1;
      const pageSize = req.query.pageSize || 20;
      const offset = (page - 1) * pageSize;
      const search = req.query.search || "";
      const active = req.query.active ?? "1";

      const where = ["user_id = ?", "is_active = ?"];
      const params = [req.user.id, active];

      if (search) {
        const like = `%${search}%`;
        where.push("(code LIKE ? OR name LIKE ? OR mobile LIKE ? OR email LIKE ?)");
        params.push(like, like, like, like);
      }

      const whereClause = where.join(" AND ");
      const [rows] = await pool.execute(
        `SELECT * FROM customers WHERE ${whereClause} ORDER BY name LIMIT ${parseInt(pageSize, 10)} OFFSET ${parseInt(offset, 10)}`,
        params
      );

      const [[countRow]] = await pool.execute(
        `SELECT COUNT(*) AS total FROM customers WHERE ${whereClause}`,
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

router.get("/:id", requirePermission("can_view_customers"), [param("id").isInt().toInt()], async (req, res, next) => {
  try {
    const [[customer]] = await pool.execute(
      "SELECT * FROM customers WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (!customer) return res.status(404).json({ ok: false, error: "Customer not found" });
    return res.json({ ok: true, data: customer });
  } catch (error) {
    next(error);
  }
});

router.post("/", requirePermission("can_add_customers"), customerValidation, async (req, res, next) => {
  const err = validationErrors(req, res);
  if (err) return;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const { salutation, name, mobile, address, email, gstin } = req.body;
    const code = await getNextCode(conn, "CUSTOMER");

    const [result] = await conn.execute(
      `INSERT INTO customers (user_id, code, salutation, name, mobile, address, email, gstin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, code, salutation, name, mobile, address, email || null, gstin || null]
    );

    await logActivity(conn, {
      userId: req.user.id,
      type: "CUSTOMER_CREATED",
      entityId: result.insertId,
      entityCode: code,
      description: `Customer created: ${salutation} ${name} (${code})`,
    });

    await conn.commit();

    const [[customer]] = await pool.execute(
      "SELECT * FROM customers WHERE id = ? AND user_id = ?",
      [result.insertId, req.user.id]
    );

    return res.status(201).json({ ok: true, data: customer, message: "Customer created successfully" });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

router.put("/:id", requirePermission("can_edit_customers"), [param("id").isInt().toInt(), ...customerValidation], async (req, res, next) => {
  const err = validationErrors(req, res);
  if (err) return;

  try {
    const [[existing]] = await pool.execute(
      "SELECT * FROM customers WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );

    if (!existing) return res.status(404).json({ ok: false, error: "Customer not found" });

    const { salutation, name, mobile, address, email, gstin } = req.body;

    await pool.execute(
      `UPDATE customers
       SET salutation = ?, name = ?, mobile = ?, address = ?, email = ?, gstin = ?
       WHERE id = ? AND user_id = ?`,
      [salutation, name, mobile, address, email || null, gstin || null, req.params.id, req.user.id]
    );

    return res.json({ ok: true, message: "Customer updated successfully" });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", requirePermission("can_delete_customers"), [param("id").isInt().toInt()], async (req, res, next) => {
  try {
    const [[existing]] = await pool.execute(
      "SELECT * FROM customers WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );

    if (!existing) return res.status(404).json({ ok: false, error: "Customer not found" });

    await pool.execute(
      "UPDATE customers SET is_active = 0 WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );

    return res.json({ ok: true, message: "Customer deleted successfully" });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
