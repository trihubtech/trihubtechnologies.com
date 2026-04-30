


const router  = require("express").Router();
const { pool, getNextCode, adjustStock, logActivity } = require("../config/db");
const { body, param, query, validationResult } = require("express-validator");
const { numberToWords, round2 } = require("../utils/helpers");
const { requirePermission } = require("../middleware/permissions");





function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      ok: false,
      error: "Validation failed",
      details: errors.mapped(),
    });
  }
  return null;
}

function calcItemTotals(rate, quantity, taxRate) {
  const value    = round2(rate * quantity);
  const tax_value = round2(value * (taxRate / 100));
  const total_value = round2(value + tax_value);
  return { value, tax_value, total_value };
}

function calcInvoiceTotals(items, discount) {
  const subTotal = round2(items.reduce((s, i) => s + Number(i.value || 0), 0));
  const totalTax = round2(items.reduce((s, i) => s + Number(i.tax_value || 0), 0));
  const rawGrand = round2(subTotal - discount + totalTax);
  const grandTotal = round2(Math.round(rawGrand));
  const roundOff  = round2(grandTotal - rawGrand);
  return { subTotal, totalTax, roundOff, grandTotal };
}




router.get(
  "/",
  requirePermission("can_list_invoices"),
  [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("pageSize").optional().isInt({ min: 1, max: 200 }).toInt(),
    query("search").optional().trim(),
    query("status").optional().isIn(["PAID", "PARTIAL", "UNPAID"]),
    query("from").optional().isISO8601(),
    query("to").optional().isISO8601(),
  ],
  async (req, res, next) => {
    try {
      const page     = req.query.page     || 1;
      const pageSize = req.query.pageSize || 20;
      const offset   = (page - 1) * pageSize;
      const search   = req.query.search || "";
      const status   = req.query.status || null;
      const from     = req.query.from   || null;
      const to       = req.query.to     || null;

      let where = ["i.user_id = ?", "c.user_id = ?"];
      let params = [req.user.id, req.user.id];

      if (search) {
        where.push("(i.code LIKE ? OR i.number LIKE ? OR c.name LIKE ?)");
        const like = `%${search}%`;
        params.push(like, like, like);
      }
      if (status) { where.push("i.status = ?");    params.push(status); }
      if (from)   { where.push("i.date >= ?");     params.push(from); }
      if (to)     { where.push("i.date <= ?");     params.push(to); }

      const whereClause = where.join(" AND ");

      const [rows] = await pool.execute(
        `SELECT
           i.id, i.code, i.number, i.date, i.term,
           i.grand_total, i.paid_amount, i.balance, i.status,
           c.id AS customer_id, c.name AS customer_name,
           c.mobile AS customer_mobile
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id
         WHERE ${whereClause}
         ORDER BY i.id DESC
         LIMIT ${parseInt(pageSize, 10)} OFFSET ${parseInt(offset, 10)}`,
        params
      );

      const [[countRow]] = await pool.execute(
        `SELECT COUNT(*) AS total
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id
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
    } catch (err) {
      next(err);
    }
  }
);




router.get(
  "/:id",
  requirePermission("can_view_invoices"),
  [param("id").isInt().toInt()],
  async (req, res, next) => {
    try {
      const [[invoice]] = await pool.execute(
        `SELECT
           i.*,
           c.code AS customer_code, c.salutation AS customer_salutation,
           c.name AS customer_name, c.mobile AS customer_mobile,
           c.address AS customer_address, c.email AS customer_email,
           c.gstin AS customer_gstin
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id
         WHERE i.id = ? AND i.user_id = ? AND c.user_id = ?`,
        [req.params.id, req.user.id, req.user.id]
      );

      if (!invoice) return res.status(404).json({ ok: false, error: "Invoice not found" });

      const [items] = await pool.execute(
        `SELECT
           ii.*,
           p.code AS product_code, p.name AS product_name,
           p.unit AS product_unit, p.category AS product_category
         FROM invoice_items ii
         JOIN products p ON p.id = ii.product_id
         WHERE ii.invoice_id = ? AND ii.user_id = ? AND p.user_id = ?
         ORDER BY ii.id ASC`,
        [req.params.id, req.user.id, req.user.id]
      );

      return res.json({ ok: true, data: { ...invoice, items } });
    } catch (err) {
      next(err);
    }
  }
);




const invoiceValidation = [
  body("date").isISO8601().withMessage("Invalid date"),
  body("term").isIn(["CASH", "CARD", "UPI", "CREDIT"]).withMessage("Invalid payment term"),
  body("customer_id").isInt({ min: 1 }).withMessage("Customer is required"),
  body("discount").optional().isFloat({ min: 0 }).withMessage("Discount must be non-negative"),
  body("items").isArray({ min: 1 }).withMessage("At least one item is required"),
  body("items.*.product_id").isInt({ min: 1 }).withMessage("Invalid product"),
  body("items.*.rate").isFloat({ min: 0.01 }).withMessage("Rate must be positive"),
  body("items.*.quantity").isFloat({ min: 0.01 }).withMessage("Quantity must be positive"),
];




router.post(
  "/",
  requirePermission("can_add_invoices"),
  invoiceValidation,
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const {
        date,
        term,
        customer_id,
        notes = null,
        discount: rawDiscount = 0,
        paid_amount: rawPaidAmount = 0,
        items: rawItems,
      } = req.body;

      const discount   = round2(Number(rawDiscount));
      const paidAmount = round2(Number(rawPaidAmount));

      
      const [[customer]] = await conn.execute(
        "SELECT id, name, balance FROM customers WHERE id = ? AND user_id = ? AND is_active = 1",
        [customer_id, req.user.id]
      );
      if (!customer) {
        await conn.rollback();
        return res.status(422).json({ ok: false, error: "Customer not found" });
      }

      
      const processedItems = [];
      for (const item of rawItems) {
        const [[product]] = await conn.execute(
          "SELECT id, name, tax_rate FROM products WHERE id = ? AND user_id = ? AND is_active = 1",
          [item.product_id, req.user.id]
        );
        if (!product) {
          await conn.rollback();
          return res.status(422).json({
            ok: false,
            error: `Product #${item.product_id} not found`,
          });
        }

        const rate     = round2(Number(item.rate));
        const quantity = round2(Number(item.quantity));
        const taxRate  = round2(Number(product.tax_rate));
        const { value, tax_value, total_value } = calcItemTotals(rate, quantity, taxRate);

        processedItems.push({
          product_id: product.id,
          rate,
          quantity,
          value,
          tax_rate: taxRate,
          tax_value,
          total_value,
        });
      }

      
      const { subTotal, totalTax, roundOff, grandTotal } =
        calcInvoiceTotals(processedItems, discount);

      const amountInWords = numberToWords(grandTotal);
      const previousBalance = round2(Number(customer.balance || 0));
      const netPayable = round2(grandTotal - previousBalance);
      const balance = round2(previousBalance + paidAmount - grandTotal);
      const status  = balance >= -0.01 ? "PAID" : (paidAmount > 0 ? "PARTIAL" : "UNPAID");

      
      const invoiceCode = await getNextCode(conn, "INVOICE");

      
      const [invoiceResult] = await conn.execute(
        `INSERT INTO invoices
           (user_id, code, number, date, term, customer_id, sub_total, discount,
            total_tax, round_off, grand_total, amount_in_words,
            paid_amount, balance, status, notes, previous_balance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.id, invoiceCode, invoiceCode, date, term, customer_id,
          subTotal, discount, totalTax, roundOff, grandTotal,
          amountInWords, paidAmount, balance, status, notes, previousBalance
        ]
      );
      const invoiceId = invoiceResult.insertId;

      
      await conn.execute(
        "UPDATE customers SET balance = balance + ? - ? WHERE id = ?",
        [paidAmount, grandTotal, customer_id]
      );

      
      for (const item of processedItems) {
        await conn.execute(
          `INSERT INTO invoice_items
             (user_id, invoice_id, product_id, rate, quantity, value, tax_rate, tax_value, total_value)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.user.id,
            invoiceId,
            item.product_id,
            item.rate,
            item.quantity,
            item.value,
            item.tax_rate,
            item.tax_value,
            item.total_value,
          ]
        );

        
        const stockCode = await getNextCode(conn, "INVENTORY");
        await adjustStock(conn, {
          userId:         req.user.id,
          productId:      item.product_id,
          adjustment:     -item.quantity,          
          type:           "SALE",
          reason:         `Sale — Invoice ${invoiceCode}`,
          refId:          invoiceId,
          refCode:        invoiceCode,
          inventoryCode:  stockCode,
        });
      }

      
      await logActivity(conn, {
        userId:      req.user.id,
        type:        "INVOICE_CREATED",
        entityId:    invoiceId,
        entityCode:  invoiceCode,
        description: `Invoice ${invoiceCode} created for ${customer.name} — ₹${grandTotal}`,
      });

      await conn.commit();

      
      const [[created]] = await pool.execute(
        `SELECT i.*, c.name AS customer_name, c.mobile AS customer_mobile,
                c.address AS customer_address
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id
         WHERE i.id = ? AND i.user_id = ? AND c.user_id = ?`,
        [invoiceId, req.user.id, req.user.id]
      );

      return res.status(201).json({ ok: true, data: created, message: "Invoice created successfully" });
    } catch (err) {
      await conn.rollback();
      next(err);
    } finally {
      conn.release();
    }
  }
);




router.put(
  "/:id",
  requirePermission("can_edit_invoices"),
  [param("id").isInt().toInt(), ...invoiceValidation],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const invoiceId = req.params.id;

      
      const [[existing]] = await conn.execute(
        "SELECT * FROM invoices WHERE id = ? AND user_id = ? FOR UPDATE",
        [invoiceId, req.user.id]
      );
      if (!existing) {
        await conn.rollback();
        return res.status(404).json({ ok: false, error: "Invoice not found" });
      }

      const [oldItems] = await conn.execute(
        "SELECT * FROM invoice_items WHERE invoice_id = ? AND user_id = ?",
        [invoiceId, req.user.id]
      );

      const {
        date,
        term,
        customer_id,
        notes = null,
        discount: rawDiscount = 0,
        paid_amount: rawPaidAmount = 0,
        items: rawItems,
      } = req.body;

      const discount   = round2(Number(rawDiscount));
      const paidAmount = round2(Number(rawPaidAmount));

      
      const [[customer]] = await conn.execute(
        "SELECT id, name FROM customers WHERE id = ? AND user_id = ? AND is_active = 1",
        [customer_id, req.user.id]
      );
      if (!customer) {
        await conn.rollback();
        return res.status(422).json({ ok: false, error: "Customer not found" });
      }

      
      const processedItems = [];
      for (const item of rawItems) {
        const [[product]] = await conn.execute(
          "SELECT id, name, tax_rate FROM products WHERE id = ? AND user_id = ? AND is_active = 1",
          [item.product_id, req.user.id]
        );
        if (!product) {
          await conn.rollback();
          return res.status(422).json({ ok: false, error: `Product #${item.product_id} not found` });
        }

        const rate     = round2(Number(item.rate));
        const quantity = round2(Number(item.quantity));
        const taxRate  = round2(Number(product.tax_rate));
        const { value, tax_value, total_value } = calcItemTotals(rate, quantity, taxRate);

        processedItems.push({ product_id: product.id, rate, quantity, value, tax_rate: taxRate, tax_value, total_value });
      }

      
      
      for (const old of oldItems) {
        const stockCode = await getNextCode(conn, "INVENTORY");
        await adjustStock(conn, {
          userId:         req.user.id,
          productId:     old.product_id,
          adjustment:    Number(old.quantity),   
          type:          "SALE_RETURN",
          reason:        `Edit reversal — Invoice ${existing.code}`,
          refId:         invoiceId,
          refCode:       existing.code,
          inventoryCode: stockCode,
        });
      }

      
      for (const item of processedItems) {
        const stockCode = await getNextCode(conn, "INVENTORY");
        await adjustStock(conn, {
          userId:         req.user.id,
          productId:     item.product_id,
          adjustment:    -item.quantity,
          type:          "SALE",
          reason:        `Sale (edited) — Invoice ${existing.code}`,
          refId:         invoiceId,
          refCode:       existing.code,
          inventoryCode: stockCode,
        });
      }

      
      const { subTotal, totalTax, roundOff, grandTotal } = calcInvoiceTotals(processedItems, discount);
      const amountInWords = numberToWords(grandTotal);
      const previousBalance = round2(Number(existing.previous_balance || 0));
      const netPayable = round2(grandTotal - previousBalance);
      const balance       = round2(previousBalance + paidAmount - grandTotal);
      const status        = balance >= -0.01 ? "PAID" : (paidAmount > 0 ? "PARTIAL" : "UNPAID");

      
      const oldEffect = round2(Number(existing.paid_amount) - Number(existing.grand_total));
      const newEffect = round2(paidAmount - grandTotal);
      
      if (existing.customer_id === customer_id) {
        const deltaEffect = round2(newEffect - oldEffect);
        await conn.execute("UPDATE customers SET balance = balance + ? WHERE id = ?", [deltaEffect, customer_id]);
      } else {
        await conn.execute("UPDATE customers SET balance = balance - ? WHERE id = ?", [oldEffect, existing.customer_id]);
        await conn.execute("UPDATE customers SET balance = balance + ? WHERE id = ?", [newEffect, customer_id]);
      }

      
      await conn.execute(
         `UPDATE invoices SET
           date = ?, term = ?, customer_id = ?, sub_total = ?,
           discount = ?, total_tax = ?, round_off = ?, grand_total = ?,
           amount_in_words = ?, paid_amount = ?, balance = ?, status = ?, notes = ?
         WHERE id = ? AND user_id = ?`,
        [
          date, term, customer_id, subTotal, discount, totalTax,
          roundOff, grandTotal, amountInWords, paidAmount, balance, status, notes,
          invoiceId, req.user.id,
        ]
      );

      
      await conn.execute("DELETE FROM invoice_items WHERE invoice_id = ? AND user_id = ?", [invoiceId, req.user.id]);

      for (const item of processedItems) {
        await conn.execute(
          `INSERT INTO invoice_items
             (user_id, invoice_id, product_id, rate, quantity, value, tax_rate, tax_value, total_value)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [req.user.id, invoiceId, item.product_id, item.rate, item.quantity, item.value, item.tax_rate, item.tax_value, item.total_value]
        );
      }

      await logActivity(conn, {
        userId:      req.user.id,
        type:        "INVOICE_UPDATED",
        entityId:    invoiceId,
        entityCode:  existing.code,
        description: `Invoice ${existing.code} updated — ₹${grandTotal}`,
      });

      await conn.commit();
      return res.json({ ok: true, message: "Invoice updated successfully" });
    } catch (err) {
      await conn.rollback();
      next(err);
    } finally {
      conn.release();
    }
  }
);




router.delete(
  "/:id",
  requirePermission("can_delete_invoices"),
  [param("id").isInt().toInt()],
  async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[invoice]] = await conn.execute(
        "SELECT * FROM invoices WHERE id = ? AND user_id = ? FOR UPDATE",
        [req.params.id, req.user.id]
      );
      if (!invoice) {
        await conn.rollback();
        return res.status(404).json({ ok: false, error: "Invoice not found" });
      }

      const [items] = await conn.execute(
        "SELECT * FROM invoice_items WHERE invoice_id = ? AND user_id = ?",
        [req.params.id, req.user.id]
      );

      
      for (const item of items) {
        const stockCode = await getNextCode(conn, "INVENTORY");
        await adjustStock(conn, {
          userId:         req.user.id,
          productId:     item.product_id,
          adjustment:    Number(item.quantity),
          type:          "SALE_RETURN",
          reason:        `Invoice deleted — ${invoice.code}`,
          refId:         invoice.id,
          refCode:       invoice.code,
          inventoryCode: stockCode,
        });
      }

      
      const oldEffect = round2(Number(invoice.paid_amount) - Number(invoice.grand_total));
      await conn.execute(
        "UPDATE customers SET balance = balance - ? WHERE id = ?",
        [oldEffect, invoice.customer_id]
      );

      await conn.execute("DELETE FROM invoices WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);

      await logActivity(conn, {
        userId:      req.user.id,
        type:        "INVOICE_DELETED",
        entityId:    invoice.id,
        entityCode:  invoice.code,
        description: `Invoice ${invoice.code} deleted — stock restored`,
      });

      await conn.commit();
      return res.json({ ok: true, message: "Invoice deleted and stock restored" });
    } catch (err) {
      await conn.rollback();
      next(err);
    } finally {
      conn.release();
    }
  }
);

module.exports = router;
