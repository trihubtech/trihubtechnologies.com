const router = require("express").Router();
const { pool } = require("../config/db");
const { query, param } = require("express-validator");
const { requirePermission } = require("../middleware/permissions");

router.get("/", requirePermission("can_list_reports"), (req, res) => {
  return res.json({
    ok: true,
    data: [
      { id: "sales_summary", name: "Sales Summary", category: "Sales" },
      { id: "invoice_detail", name: "Invoice Details", category: "Sales" },
      { id: "customer_ledger", name: "Customer Ledger", category: "Sales" },
      { id: "purchase_summary", name: "Purchase Summary", category: "Purchase" },
      { id: "vendor_ledger", name: "Vendor Ledger", category: "Purchase" },
      { id: "stock_report", name: "Stock Report", category: "Stock" },
      { id: "profit_loss", name: "Profit & Loss", category: "Financial" },
    ],
  });
});

router.get(
  "/:id",
  requirePermission("can_view_reports"),
  [
    param("id").isIn([
      "sales_summary",
      "invoice_detail",
      "customer_ledger",
      "purchase_summary",
      "vendor_ledger",
      "stock_report",
      "profit_loss",
    ]),
    query("from").optional().isISO8601(),
    query("to").optional().isISO8601(),
  ],
  async (req, res, next) => {
    try {
      const reportId = req.params.id;
      const now = new Date();
      const from = req.query.from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
      const to = req.query.to || now.toISOString().split("T")[0];
      const userId = req.user.id;

      let data = {};

      switch (reportId) {
        case "sales_summary": {
          const [rows] = await pool.execute(
            `SELECT i.code, i.date, c.name AS customer_name, i.term,
                    i.sub_total, i.discount, i.total_tax, i.grand_total,
                    i.paid_amount, i.balance, i.status
             FROM invoices i
             JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id
             WHERE i.user_id = ? AND i.date BETWEEN ? AND ?
             ORDER BY i.date DESC`,
            [userId, from, to]
          );
          const [[totals]] = await pool.execute(
            `SELECT COUNT(*) AS count,
                    COALESCE(SUM(grand_total), 0) AS total_sales,
                    COALESCE(SUM(paid_amount), 0) AS total_received,
                    COALESCE(SUM(balance), 0) AS total_outstanding
             FROM invoices
             WHERE user_id = ? AND date BETWEEN ? AND ?`,
            [userId, from, to]
          );
          data = { rows, summary: totals };
          break;
        }

        case "invoice_detail": {
          const [rows] = await pool.execute(
            `SELECT i.code, i.date, c.name AS customer_name,
                    p.name AS product_name, p.unit,
                    ii.quantity, ii.rate, ii.value, ii.tax_rate, ii.tax_value, ii.total_value
             FROM invoice_items ii
             JOIN invoices i ON i.id = ii.invoice_id AND i.user_id = ii.user_id
             JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id
             JOIN products p ON p.id = ii.product_id AND p.user_id = ii.user_id
             WHERE ii.user_id = ? AND i.date BETWEEN ? AND ?
             ORDER BY i.date DESC, i.id, ii.id`,
            [userId, from, to]
          );
          data = { rows };
          break;
        }

        case "customer_ledger": {
          const [rows] = await pool.execute(
            `SELECT c.code, c.name, c.mobile,
                    COUNT(i.id) AS invoice_count,
                    COALESCE(SUM(i.grand_total), 0) AS total_billed,
                    COALESCE(SUM(i.paid_amount), 0) AS total_paid,
                    COALESCE(SUM(i.balance), 0) AS balance_due
             FROM customers c
             LEFT JOIN invoices i ON i.customer_id = c.id AND i.user_id = c.user_id AND i.date BETWEEN ? AND ?
             WHERE c.user_id = ? AND c.is_active = 1
             GROUP BY c.id
             HAVING invoice_count > 0
             ORDER BY balance_due DESC`,
            [from, to, userId]
          );
          data = { rows };
          break;
        }

        case "purchase_summary": {
          const [rows] = await pool.execute(
            `SELECT b.code, b.date, b.vendor_invoice_number, v.name AS vendor_name, b.term,
                    b.sub_total, b.discount, b.total_tax, b.grand_total,
                    b.paid_amount, b.balance, b.status
             FROM bills b
             JOIN vendors v ON v.id = b.vendor_id AND v.user_id = b.user_id
             WHERE b.user_id = ? AND b.date BETWEEN ? AND ?
             ORDER BY b.date DESC`,
            [userId, from, to]
          );
          const [[totals]] = await pool.execute(
            `SELECT COUNT(*) AS count,
                    COALESCE(SUM(grand_total), 0) AS total_purchases,
                    COALESCE(SUM(paid_amount), 0) AS total_paid,
                    COALESCE(SUM(balance), 0) AS total_outstanding
             FROM bills
             WHERE user_id = ? AND date BETWEEN ? AND ?`,
            [userId, from, to]
          );
          data = { rows, summary: totals };
          break;
        }

        case "vendor_ledger": {
          const [rows] = await pool.execute(
            `SELECT v.code, v.name, v.mobile,
                    COUNT(b.id) AS bill_count,
                    COALESCE(SUM(b.grand_total), 0) AS total_billed,
                    COALESCE(SUM(b.paid_amount), 0) AS total_paid,
                    COALESCE(SUM(b.balance), 0) AS balance_due
             FROM vendors v
             LEFT JOIN bills b ON b.vendor_id = v.id AND b.user_id = v.user_id AND b.date BETWEEN ? AND ?
             WHERE v.user_id = ? AND v.is_active = 1
             GROUP BY v.id
             HAVING bill_count > 0
             ORDER BY balance_due DESC`,
            [from, to, userId]
          );
          data = { rows };
          break;
        }

        case "stock_report": {
          const [rows] = await pool.execute(
            `SELECT p.code, p.name, p.category, p.unit, p.price, p.mrp,
                    COALESCE((
                      SELECT new_qty
                      FROM inventory
                      WHERE product_id = p.id AND user_id = ?
                      ORDER BY id DESC
                      LIMIT 1
                    ), 0) AS current_stock,
                    COALESCE((
                      SELECT SUM(ABS(adjustment))
                      FROM inventory
                      WHERE product_id = p.id AND user_id = ? AND type = 'SALE' AND date BETWEEN ? AND ?
                    ), 0) AS sold_qty,
                    COALESCE((
                      SELECT SUM(ABS(adjustment))
                      FROM inventory
                      WHERE product_id = p.id AND user_id = ? AND type = 'PURCHASE' AND date BETWEEN ? AND ?
                    ), 0) AS purchased_qty
             FROM products p
             WHERE p.user_id = ? AND p.is_active = 1
             ORDER BY p.name`,
            [userId, userId, from, to, userId, from, to, userId]
          );
          data = { rows };
          break;
        }

        case "profit_loss": {
          const [[salesTotal]] = await pool.execute(
            "SELECT COALESCE(SUM(grand_total), 0) AS total FROM invoices WHERE user_id = ? AND date BETWEEN ? AND ?",
            [userId, from, to]
          );
          const [[purchaseTotal]] = await pool.execute(
            "SELECT COALESCE(SUM(grand_total), 0) AS total FROM bills WHERE user_id = ? AND date BETWEEN ? AND ?",
            [userId, from, to]
          );
          const [[salesDiscount]] = await pool.execute(
            "SELECT COALESCE(SUM(discount), 0) AS total FROM invoices WHERE user_id = ? AND date BETWEEN ? AND ?",
            [userId, from, to]
          );
          const [[salesTax]] = await pool.execute(
            "SELECT COALESCE(SUM(total_tax), 0) AS total FROM invoices WHERE user_id = ? AND date BETWEEN ? AND ?",
            [userId, from, to]
          );
          const [[purchaseTax]] = await pool.execute(
            "SELECT COALESCE(SUM(total_tax), 0) AS total FROM bills WHERE user_id = ? AND date BETWEEN ? AND ?",
            [userId, from, to]
          );

          data = {
            revenue: salesTotal.total,
            cost_of_goods: purchaseTotal.total,
            gross_profit: salesTotal.total - purchaseTotal.total,
            discounts_given: salesDiscount.total,
            tax_collected: salesTax.total,
            tax_paid: purchaseTax.total,
            net_tax: salesTax.total - purchaseTax.total,
          };
          break;
        }
      }

      return res.json({
        ok: true,
        report: reportId,
        dateRange: { from, to },
        data,
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
