const router = require("express").Router();
const { pool } = require("../config/db");
const { query } = require("express-validator");
const { requirePermission } = require("../middleware/permissions");
const { getIndiaPresetDateRange } = require("../utils/time");

router.get(
  "/",
  requirePermission("can_view_dashboard"),
  [
    query("preset").optional().trim(),
    query("from").optional().isISO8601(),
    query("to").optional().isISO8601(),
  ],
  async (req, res, next) => {
    try {
      let from;
      let to;

      if (req.query.from && req.query.to) {
        from = req.query.from;
        to = req.query.to;
      } else {
        const dates = getIndiaPresetDateRange(req.query.preset || "this_month");
        from = dates.from;
        to = dates.to;
      }

      const userId = req.user.id;

      const [
        [salesRow],
        [purchasesRow],
        [receivablesRow],
        [payablesRow],
        [salesChart],
        [topProducts],
        [topCustomers],
        [recentInvoices],
        [recentBills],
      ] = await Promise.all([
        pool.execute(
          `SELECT COALESCE(SUM(grand_total), 0) AS total, COUNT(*) AS count
           FROM invoices WHERE user_id = ? AND date BETWEEN ? AND ?`,
          [userId, from, to]
        ),
        pool.execute(
          `SELECT COALESCE(SUM(grand_total), 0) AS total, COUNT(*) AS count
           FROM bills WHERE user_id = ? AND date BETWEEN ? AND ?`,
          [userId, from, to]
        ),
        pool.execute(
          `SELECT COALESCE(SUM(balance), 0) AS total, COUNT(*) AS count
           FROM invoices WHERE user_id = ? AND status != 'PAID'`,
          [userId]
        ),
        pool.execute(
          `SELECT COALESCE(SUM(balance), 0) AS total, COUNT(*) AS count
           FROM bills WHERE user_id = ? AND status != 'PAID'`,
          [userId]
        ),
        pool.execute(
          `SELECT DATE(date) AS day, SUM(grand_total) AS sales, COUNT(*) AS count
           FROM invoices
           WHERE user_id = ? AND date BETWEEN ? AND ?
           GROUP BY DATE(date)
           ORDER BY day`,
          [userId, from, to]
        ),
        pool.execute(
          `SELECT p.name, SUM(ii.quantity) AS qty, SUM(ii.total_value) AS revenue
           FROM invoice_items ii
           JOIN products p ON p.id = ii.product_id AND p.user_id = ii.user_id
           JOIN invoices i ON i.id = ii.invoice_id AND i.user_id = ii.user_id
           WHERE ii.user_id = ? AND i.date BETWEEN ? AND ?
           GROUP BY p.id
           ORDER BY revenue DESC
           LIMIT 5`,
          [userId, from, to]
        ),
        pool.execute(
          `SELECT c.name, COUNT(i.id) AS invoice_count, SUM(i.grand_total) AS total
           FROM invoices i
           JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id
           WHERE i.user_id = ? AND i.date BETWEEN ? AND ?
           GROUP BY c.id
           ORDER BY total DESC
           LIMIT 5`,
          [userId, from, to]
        ),
        pool.execute(
          `SELECT i.id, i.code, i.date, i.grand_total, i.status, c.name AS customer_name
           FROM invoices i
           JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id
           WHERE i.user_id = ?
           ORDER BY i.id DESC
           LIMIT 5`,
          [userId]
        ),
        pool.execute(
          `SELECT b.id, b.code, b.date, b.grand_total, b.status, v.name AS vendor_name
           FROM bills b
           JOIN vendors v ON v.id = b.vendor_id AND v.user_id = b.user_id
           WHERE b.user_id = ?
           ORDER BY b.id DESC
           LIMIT 5`,
          [userId]
        ),
      ]);

      return res.json({
        ok: true,
        data: {
          dateRange: { from, to },
          sales: { total: salesRow[0].total, count: salesRow[0].count },
          purchases: { total: purchasesRow[0].total, count: purchasesRow[0].count },
          receivables: { total: receivablesRow[0].total, count: receivablesRow[0].count },
          payables: { total: payablesRow[0].total, count: payablesRow[0].count },
          salesChart,
          topProducts,
          topCustomers,
          recentInvoices,
          recentBills,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
