const router = require("express").Router();
const { pool } = require("../config/db");
const { query, param } = require("express-validator");
const { requirePermission } = require("../middleware/permissions");
const { ensureBillSchemaCompatibility, ensureInvoiceSchemaCompatibility } = require("../utils/transactionSchema");
const { buildGstInvoiceSpreadsheet, loadInvoiceDocument } = require("../utils/gstInvoiceDocument");
const { buildGstReportSpreadsheet } = require("../utils/gstReportSpreadsheet");
const { loadCompanyProfile } = require("../utils/tenancy");
const { getIndiaDurationDateRange, getIndiaPresetDateRange } = require("../utils/time");

function getDurationDates(duration, customStart, customEnd) {
  return getIndiaDurationDateRange(duration, customStart, customEnd);
}

router.get(
  "/gst/invoices",
  requirePermission("can_view_reports"),
  [
    query("duration").optional().isIn(["this_week", "this_month", "last_month", "last_6_months", "last_1_year", "custom"]),
    query("start_date").optional().isISO8601(),
    query("end_date").optional().isISO8601(),
  ],
  async (req, res, next) => {
    try {
      await ensureInvoiceSchemaCompatibility(pool);
      const { duration, start_date, end_date } = req.query;
      const { from, to } = getDurationDates(duration, start_date, end_date);

      const [products] = await pool.execute(
        `SELECT 
           i.date AS transaction_date,
           i.code AS invoice_number,
           p.name AS product_name,
           ii.product_tag,
           ii.hsn_sac_code,
           ii.rate,
           ii.tax_rate AS gst_percentage,
           i.supply_type,
           ii.cgst_rate,
           ii.cgst_amount,
           ii.sgst_rate,
           ii.sgst_amount,
           ii.igst_rate,
           ii.igst_amount,
           ii.tax_value AS total_gst_amount
         FROM invoice_items ii
         JOIN invoices i ON i.id = ii.invoice_id AND i.user_id = ii.user_id
         LEFT JOIN products p ON p.id = ii.product_id AND p.user_id = ii.user_id
         WHERE ii.user_id = ? AND i.date BETWEEN ? AND ?
         ORDER BY p.name ASC, i.date DESC, i.id DESC`,
        [req.user.id, from, to]
      );

      const [[summary]] = await pool.execute(
        `SELECT 
           COALESCE(SUM(ii.igst_amount), 0) AS total_igst,
           COALESCE(SUM(ii.cgst_amount), 0) AS total_cgst,
           COALESCE(SUM(ii.sgst_amount), 0) AS total_sgst,
           COALESCE(SUM(ii.tax_value), 0) AS grand_total_gst
         FROM invoice_items ii
         JOIN invoices i ON i.id = ii.invoice_id AND i.user_id = ii.user_id
         WHERE ii.user_id = ? AND i.date BETWEEN ? AND ?`,
        [req.user.id, from, to]
      );

      return res.json({
        ok: true,
        duration_label: `${from} – ${to}`,
        start_date: from,
        end_date: to,
        products,
        summary
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/gst/bills",
  requirePermission("can_view_reports"),
  [
    query("duration").optional().isIn(["this_week", "this_month", "last_month", "last_6_months", "last_1_year", "custom"]),
    query("start_date").optional().isISO8601(),
    query("end_date").optional().isISO8601(),
  ],
  async (req, res, next) => {
    try {
      await ensureBillSchemaCompatibility(pool);
      const { duration, start_date, end_date } = req.query;
      const { from, to } = getDurationDates(duration, start_date, end_date);

      const [products] = await pool.execute(
        `SELECT 
           b.date AS transaction_date,
           b.code AS invoice_number,
           p.name AS product_name,
           bi.product_tag,
           bi.hsn_sac_code,
           bi.rate,
           bi.tax_rate AS gst_percentage,
           b.supply_type,
           bi.cgst_rate,
           bi.cgst_amount,
           bi.sgst_rate,
           bi.sgst_amount,
           bi.igst_rate,
           bi.igst_amount,
           bi.tax_value AS total_gst_amount
         FROM bill_items bi
         JOIN bills b ON b.id = bi.bill_id AND b.user_id = bi.user_id
         LEFT JOIN products p ON p.id = bi.product_id AND p.user_id = bi.user_id
         WHERE bi.user_id = ? AND b.date BETWEEN ? AND ?
         ORDER BY p.name ASC, b.date DESC, b.id DESC`,
        [req.user.id, from, to]
      );

      const [[summary]] = await pool.execute(
        `SELECT 
           COALESCE(SUM(bi.igst_amount), 0) AS total_igst,
           COALESCE(SUM(bi.cgst_amount), 0) AS total_cgst,
           COALESCE(SUM(bi.sgst_amount), 0) AS total_sgst,
           COALESCE(SUM(bi.tax_value), 0) AS grand_total_gst
         FROM bill_items bi
         JOIN bills b ON b.id = bi.bill_id AND b.user_id = bi.user_id
         WHERE bi.user_id = ? AND b.date BETWEEN ? AND ?`,
        [req.user.id, from, to]
      );

      return res.json({
        ok: true,
        duration_label: `${from} – ${to}`,
        start_date: from,
        end_date: to,
        products,
        summary
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get("/", requirePermission("can_list_reports"), (req, res) => {
  return res.json({
    ok: true,
    data: [
      { id: "sales_summary", name: "Sales Summary", category: "Sales" },
      { id: "invoice_detail", name: "Invoice Details", category: "Sales" },
      { id: "gst_summary", name: "GST Summary", category: "Sales" },
      { id: "gst_invoice_document", name: "GST Invoice Document", category: "Documents" },
      { id: "customer_ledger", name: "Customer Ledger", category: "Sales" },
      { id: "purchase_summary", name: "Purchase Summary", category: "Purchase" },
      { id: "purchase_gst_summary", name: "Input GST Summary", category: "Purchase" },
      { id: "vendor_ledger", name: "Vendor Ledger", category: "Purchase" },
      { id: "stock_report", name: "Stock Report", category: "Stock" },
      { id: "profit_loss", name: "Profit & Loss", category: "Financial" },
    ],
  });
});

router.get(
  "/gst-invoice-document/invoices/:invoiceId/excel",
  requirePermission("can_view_reports"),
  [param("invoiceId").isInt().toInt()],
  async (req, res, next) => {
    try {
      await ensureInvoiceSchemaCompatibility(pool);
      const document = await loadInvoiceDocument(
        pool,
        req.user.id,
        req.user.company_id,
        req.params.invoiceId
      );

      if (!document) {
        return res.status(404).json({ ok: false, error: "Invoice not found" });
      }

      const fileName = `${document.invoice.number || document.invoice.code || `invoice-${req.params.invoiceId}`}.xls`
        .replace(/[^\w.-]+/g, "_");

      res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      return res.send(buildGstInvoiceSpreadsheet(document));
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/gst-invoice-document/invoices/:invoiceId",
  requirePermission("can_view_reports"),
  [param("invoiceId").isInt().toInt()],
  async (req, res, next) => {
    try {
      await ensureInvoiceSchemaCompatibility(pool);
      const document = await loadInvoiceDocument(
        pool,
        req.user.id,
        req.user.company_id,
        req.params.invoiceId
      );

      if (!document) {
        return res.status(404).json({ ok: false, error: "Invoice not found" });
      }

      return res.json({ ok: true, data: document });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/:id",
  requirePermission("can_view_reports"),
  [
    param("id").isIn([
      "sales_summary",
      "invoice_detail",
      "gst_summary",
      "gst_invoice_document",
      "customer_ledger",
      "purchase_summary",
      "purchase_gst_summary",
      "vendor_ledger",
      "stock_report",
      "profit_loss",
    ]),
    query("from").optional().isISO8601(),
    query("to").optional().isISO8601(),
  ],
  async (req, res, next) => {
    try {
      await Promise.all([
        ensureInvoiceSchemaCompatibility(pool),
        ensureBillSchemaCompatibility(pool),
      ]);
      const reportId = req.params.id;
      const defaultRange = getIndiaPresetDateRange("this_month");
      const from = req.query.from || defaultRange.from;
      const to = req.query.to || defaultRange.to;
      const userId = req.user.id;

      let data = {};

      switch (reportId) {
        case "sales_summary": {
          const [rows] = await pool.execute(
            `SELECT i.code, i.date,
                    COALESCE(i.customer_name, c.name) AS customer_name,
                    i.term, i.supply_type, i.place_of_supply_state_name,
                    i.sub_total, i.discount, i.discount_type, i.discount_input, i.taxable_total,
                    i.total_cgst, i.total_sgst, i.total_igst, i.total_tax, i.grand_total,
                    i.paid_amount, i.balance, i.status
             FROM invoices i
             LEFT JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id
             WHERE i.user_id = ? AND i.date BETWEEN ? AND ?
             ORDER BY i.date DESC`,
            [userId, from, to]
          );
          const [[totals]] = await pool.execute(
            `SELECT COUNT(*) AS count,
                    COALESCE(SUM(grand_total), 0) AS total_sales,
                    COALESCE(SUM(taxable_total), 0) AS total_taxable_value,
                    COALESCE(SUM(total_cgst), 0) AS total_cgst,
                    COALESCE(SUM(total_sgst), 0) AS total_sgst,
                    COALESCE(SUM(total_igst), 0) AS total_igst,
                    COALESCE(SUM(total_tax), 0) AS total_gst,
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
            `SELECT i.code, i.date,
                    COALESCE(i.customer_name, c.name) AS customer_name,
                    COALESCE(i.customer_gstin, c.gstin) AS customer_gstin,
                    i.supply_type, i.place_of_supply_state_name,
                    p.name AS product_name, p.unit,
                    COALESCE(ii.hsn_sac_code, p.hsn_sac_code, '') AS hsn_sac_code,
                    ii.quantity, ii.rate, ii.base_value, ii.discount_value,
                    ii.taxable_value, ii.tax_rate,
                    ii.cgst_rate, ii.cgst_amount,
                    ii.sgst_rate, ii.sgst_amount,
                    ii.igst_rate, ii.igst_amount,
                    ii.tax_value, ii.total_value
             FROM invoice_items ii
             JOIN invoices i ON i.id = ii.invoice_id AND i.user_id = ii.user_id
             LEFT JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id
             LEFT JOIN products p ON p.id = ii.product_id AND p.user_id = ii.user_id
             WHERE ii.user_id = ? AND i.date BETWEEN ? AND ?
             ORDER BY i.date DESC, i.id, ii.id`,
            [userId, from, to]
          );
          data = { rows };
          break;
        }

        case "gst_summary": {
          const [rows] = await pool.execute(
            `SELECT
               COALESCE(NULLIF(i.place_of_supply_state_name, ''), i.place_of_supply_country, 'Unknown') AS place_of_supply,
               i.supply_type,
               ii.tax_rate AS gst_rate,
               COUNT(*) AS line_count,
               COALESCE(SUM(ii.taxable_value), 0) AS taxable_value,
               COALESCE(SUM(ii.cgst_amount), 0) AS cgst_amount,
               COALESCE(SUM(ii.sgst_amount), 0) AS sgst_amount,
               COALESCE(SUM(ii.igst_amount), 0) AS igst_amount,
               COALESCE(SUM(ii.tax_value), 0) AS total_gst,
               COALESCE(SUM(ii.total_value), 0) AS invoice_value
             FROM invoice_items ii
             JOIN invoices i ON i.id = ii.invoice_id AND i.user_id = ii.user_id
             WHERE ii.user_id = ? AND i.date BETWEEN ? AND ?
             GROUP BY place_of_supply, i.supply_type, ii.tax_rate
             ORDER BY i.supply_type, ii.tax_rate, place_of_supply`,
            [userId, from, to]
          );
          const [[summary]] = await pool.execute(
            `SELECT
               COUNT(DISTINCT i.id) AS invoice_count,
               COALESCE(SUM(i.taxable_total), 0) AS total_taxable_value,
               COALESCE(SUM(i.total_cgst), 0) AS total_cgst,
               COALESCE(SUM(i.total_sgst), 0) AS total_sgst,
               COALESCE(SUM(i.total_igst), 0) AS total_igst,
               COALESCE(SUM(i.total_tax), 0) AS total_gst,
               COALESCE(SUM(i.grand_total), 0) AS total_invoice_value
             FROM invoices i
             WHERE i.user_id = ? AND i.date BETWEEN ? AND ?`,
            [userId, from, to]
          );
          data = { rows, summary };
          break;
        }

        case "gst_invoice_document": {
          const [rows] = await pool.execute(
            `SELECT
               i.id,
               i.code,
               i.number,
               i.date,
               COALESCE(i.customer_name, c.name) AS customer_name,
               i.place_of_supply_state_name,
               i.place_of_supply_country,
               i.supply_type,
               i.taxable_total,
               i.total_tax,
               i.grand_total
             FROM invoices i
             LEFT JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id
             WHERE i.user_id = ? AND i.date BETWEEN ? AND ?
             ORDER BY i.date DESC, i.id DESC`,
            [userId, from, to]
          );
          const [[summary]] = await pool.execute(
            `SELECT
               COUNT(*) AS invoice_count,
               COALESCE(SUM(taxable_total), 0) AS total_taxable_value,
               COALESCE(SUM(total_tax), 0) AS total_tax,
               COALESCE(SUM(grand_total), 0) AS total_invoice_value
             FROM invoices
             WHERE user_id = ? AND date BETWEEN ? AND ?`,
            [userId, from, to]
          );
          data = {
            rows,
            summary,
            selected_invoice_id: rows[0]?.id || null,
          };
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
            `SELECT b.code, b.date, b.vendor_invoice_number,
                    COALESCE(b.vendor_name, v.name) AS vendor_name,
                    b.term, b.supply_type, b.place_of_supply_state_name,
                    b.sub_total, b.discount, b.discount_type, b.discount_input,
                    COALESCE(NULLIF(b.taxable_total, 0), b.sub_total - b.discount) AS taxable_total,
                    b.total_cgst, b.total_sgst, b.total_igst, b.total_tax, b.grand_total,
                    b.paid_amount, b.balance, b.status
             FROM bills b
             LEFT JOIN vendors v ON v.id = b.vendor_id AND v.user_id = b.user_id
             WHERE b.user_id = ? AND b.date BETWEEN ? AND ?
             ORDER BY b.date DESC`,
            [userId, from, to]
          );
          const [[totals]] = await pool.execute(
            `SELECT COUNT(*) AS count,
                    COALESCE(SUM(grand_total), 0) AS total_purchases,
                    COALESCE(SUM(COALESCE(NULLIF(taxable_total, 0), sub_total - discount)), 0) AS total_taxable_value,
                    COALESCE(SUM(total_cgst), 0) AS total_cgst,
                    COALESCE(SUM(total_sgst), 0) AS total_sgst,
                    COALESCE(SUM(total_igst), 0) AS total_igst,
                    COALESCE(SUM(total_tax), 0) AS total_input_gst,
                    COALESCE(SUM(paid_amount), 0) AS total_paid,
                    COALESCE(SUM(balance), 0) AS total_outstanding
             FROM bills
             WHERE user_id = ? AND date BETWEEN ? AND ?`,
            [userId, from, to]
          );
          data = { rows, summary: totals };
          break;
        }

        case "purchase_gst_summary": {
          const [rows] = await pool.execute(
            `SELECT
               COALESCE(NULLIF(b.place_of_supply_state_name, ''), b.place_of_supply_country, 'Unknown') AS place_of_supply,
               b.supply_type,
               bi.tax_rate AS gst_rate,
               COUNT(*) AS line_count,
               COALESCE(SUM(COALESCE(NULLIF(bi.taxable_value, 0), bi.value)), 0) AS taxable_value,
               COALESCE(SUM(bi.cgst_amount), 0) AS cgst_amount,
               COALESCE(SUM(bi.sgst_amount), 0) AS sgst_amount,
               COALESCE(SUM(bi.igst_amount), 0) AS igst_amount,
               COALESCE(SUM(bi.tax_value), 0) AS total_gst,
               COALESCE(SUM(bi.total_value), 0) AS purchase_value
             FROM bill_items bi
             JOIN bills b ON b.id = bi.bill_id AND b.user_id = bi.user_id
             WHERE bi.user_id = ? AND b.date BETWEEN ? AND ?
             GROUP BY place_of_supply, b.supply_type, bi.tax_rate
             ORDER BY b.supply_type, bi.tax_rate, place_of_supply`,
            [userId, from, to]
          );
          const [[summary]] = await pool.execute(
            `SELECT
               COUNT(DISTINCT b.id) AS bill_count,
               COALESCE(SUM(COALESCE(NULLIF(b.taxable_total, 0), b.sub_total - b.discount)), 0) AS total_taxable_value,
               COALESCE(SUM(b.total_cgst), 0) AS total_cgst,
               COALESCE(SUM(b.total_sgst), 0) AS total_sgst,
               COALESCE(SUM(b.total_igst), 0) AS total_igst,
               COALESCE(SUM(b.total_tax), 0) AS total_input_gst,
               COALESCE(SUM(b.grand_total), 0) AS total_purchase_value
             FROM bills b
             WHERE b.user_id = ? AND b.date BETWEEN ? AND ?`,
            [userId, from, to]
          );
          data = { rows, summary };
          break;
        }

        case "vendor_ledger": {
          const [rows] = await pool.execute(
            `SELECT v.code, v.name, v.mobile,
                    COUNT(b.id) AS bill_count,
                    COALESCE(SUM(COALESCE(NULLIF(b.taxable_total, 0), b.sub_total - b.discount)), 0) AS total_taxable_value,
                    COALESCE(SUM(b.total_tax), 0) AS total_input_gst,
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

router.get(
  "/gst/:type/excel",
  requirePermission("can_view_reports"),
  [
    param("type").isIn(["invoices", "bills"]),
    query("duration").optional().isIn(["this_week", "this_month", "last_month", "last_6_months", "last_1_year", "custom"]),
    query("start_date").optional().isISO8601(),
    query("end_date").optional().isISO8601(),
  ],
  async (req, res, next) => {
    try {
      const { type } = req.params;
      const { duration, start_date, end_date } = req.query;
      const { from, to } = getDurationDates(duration, start_date, end_date);
      const userId = req.user.id;

      let productsQuery = "";
      let summaryQuery = "";

      if (type === "invoices") {
        await ensureInvoiceSchemaCompatibility(pool);
        productsQuery = `
          SELECT 
            i.date AS transaction_date, i.code AS invoice_number, p.name AS product_name,
            ii.product_tag, ii.hsn_sac_code, ii.rate, ii.tax_rate AS gst_percentage,
            i.supply_type, ii.cgst_rate, ii.cgst_amount, ii.sgst_rate, ii.sgst_amount,
            ii.igst_rate, ii.igst_amount, ii.tax_value AS total_gst_amount
          FROM invoice_items ii
          JOIN invoices i ON i.id = ii.invoice_id AND i.user_id = ii.user_id
          LEFT JOIN products p ON p.id = ii.product_id AND p.user_id = ii.user_id
          WHERE ii.user_id = ? AND i.date BETWEEN ? AND ?
          ORDER BY p.name ASC, i.date DESC`;
        
        summaryQuery = `
          SELECT 
            COALESCE(SUM(ii.igst_amount), 0) AS total_igst,
            COALESCE(SUM(ii.cgst_amount), 0) AS total_cgst,
            COALESCE(SUM(ii.sgst_amount), 0) AS total_sgst,
            COALESCE(SUM(ii.tax_value), 0) AS grand_total_gst
          FROM invoice_items ii
          JOIN invoices i ON i.id = ii.invoice_id AND i.user_id = ii.user_id
          WHERE ii.user_id = ? AND i.date BETWEEN ? AND ?`;
      } else {
        await ensureBillSchemaCompatibility(pool);
        productsQuery = `
          SELECT 
            b.date AS transaction_date, b.code AS invoice_number, p.name AS product_name,
            bi.product_tag, bi.hsn_sac_code, bi.rate, bi.tax_rate AS gst_percentage,
            b.supply_type, bi.cgst_rate, bi.cgst_amount, bi.sgst_rate, bi.sgst_amount,
            bi.igst_rate, bi.igst_amount, bi.tax_value AS total_gst_amount
          FROM bill_items bi
          JOIN bills b ON b.id = bi.bill_id AND b.user_id = bi.user_id
          LEFT JOIN products p ON p.id = bi.product_id AND p.user_id = bi.user_id
          WHERE bi.user_id = ? AND b.date BETWEEN ? AND ?
          ORDER BY p.name ASC, b.date DESC`;

        summaryQuery = `
          SELECT 
            COALESCE(SUM(bi.igst_amount), 0) AS total_igst,
            COALESCE(SUM(bi.cgst_amount), 0) AS total_cgst,
            COALESCE(SUM(bi.sgst_amount), 0) AS total_sgst,
            COALESCE(SUM(bi.tax_value), 0) AS grand_total_gst
          FROM bill_items bi
          JOIN bills b ON b.id = bi.bill_id AND b.user_id = bi.user_id
          WHERE bi.user_id = ? AND b.date BETWEEN ? AND ?`;
      }

      const [products] = await pool.execute(productsQuery, [userId, from, to]);
      const [[summary]] = await pool.execute(summaryQuery, [userId, from, to]);
      
      const company = await loadCompanyProfile(pool, req.user.company_id);
      const companyName = company?.name || "My Business";

      const reportData = {
        products,
        summary,
        duration_label: `${from} to ${to}`
      };

      const typeLabel = type === "invoices" ? "Sales" : "Purchase";
      const fileName = `GST_${typeLabel}_Report_${from}_${to}.xls`.replace(/[^\w.-]+/g, "_");

      res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      
      return res.send(buildGstReportSpreadsheet(reportData, typeLabel, companyName));
    } catch (error) {
      next(error);
    }
  }
);


module.exports = router;
