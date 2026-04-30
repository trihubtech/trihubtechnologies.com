



const router = require("express").Router();
const { pool, getNextCode, adjustStock, logActivity } = require("../config/db");
const { body, param, query, validationResult } = require("express-validator");
const { numberToWords, round2 } = require("../utils/helpers");
const { requirePermission } = require("../middleware/permissions");

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ ok: false, error: "Validation failed", details: errors.mapped() });
  }
  return null;
}

function calcItemTotals(rate, quantity, taxRate) {
  const value    = round2(rate * quantity);
  const taxValue = round2(value * (taxRate / 100));
  const total    = round2(value + taxValue);
  return { value, taxValue, total };
}

function calcBillTotals(items, discount) {
  const subTotal = round2(items.reduce((s, i) => s + Number(i.value ?? 0), 0));
  const totalTax = round2(items.reduce((s, i) => s + Number(i.taxValue ?? i.tax_value ?? 0), 0));
  const rawGrand = subTotal - discount + totalTax;
  const grandTotal = round2(Math.round(rawGrand));
  const roundOff   = round2(grandTotal - rawGrand);
  return { subTotal, totalTax, roundOff, grandTotal };
}




router.get(
  "/",
  requirePermission("can_list_bills"),
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

      let where = ["b.user_id = ?", "v.user_id = ?"];
      let params = [req.user.id, req.user.id];

      if (search) {
        where.push("(b.code LIKE ? OR b.number LIKE ? OR b.vendor_invoice_number LIKE ? OR v.name LIKE ?)");
        const like = `%${search}%`;
        params.push(like, like, like, like);
      }
      if (status) { where.push("b.status = ?"); params.push(status); }
      if (from)   { where.push("b.date >= ?");  params.push(from); }
      if (to)     { where.push("b.date <= ?");  params.push(to); }

      const whereClause = where.join(" AND ");

      const [rows] = await pool.execute(
        `SELECT
           b.id, b.code, b.number, b.vendor_invoice_number, b.date, b.term,
           b.grand_total, b.paid_amount, b.balance, b.status,
           v.id AS vendor_id, v.name AS vendor_name, v.mobile AS vendor_mobile
         FROM bills b
         JOIN vendors v ON v.id = b.vendor_id
         WHERE ${whereClause}
         ORDER BY b.id DESC
         LIMIT ${parseInt(pageSize, 10)} OFFSET ${parseInt(offset, 10)}`,
        params
      );

      const [[countRow]] = await pool.execute(
        `SELECT COUNT(*) AS total FROM bills b JOIN vendors v ON v.id = b.vendor_id WHERE ${whereClause}`,
        params
      );

      return res.json({
        ok: true, data: rows, total: countRow.total,
        page, pageSize, totalPages: Math.ceil(countRow.total / pageSize),
      });
    } catch (err) {
      next(err);
    }
  }
);




router.get(
  "/:id",
  requirePermission("can_view_bills"),
  [param("id").isInt().toInt()],
  async (req, res, next) => {
    try {
      const [[bill]] = await pool.execute(
        `SELECT b.*,
           v.code AS vendor_code, v.salutation AS vendor_salutation,
           v.name AS vendor_name, v.mobile AS vendor_mobile,
           v.address AS vendor_address, v.email AS vendor_email,
           v.gstin AS vendor_gstin
         FROM bills b
         JOIN vendors v ON v.id = b.vendor_id
         WHERE b.id = ? AND b.user_id = ? AND v.user_id = ?`,
        [req.params.id, req.user.id, req.user.id]
      );
      if (!bill) return res.status(404).json({ ok: false, error: "Bill not found" });

      const [items] = await pool.execute(
        `SELECT bi.*,
           p.code AS product_code, p.name AS product_name,
           p.unit AS product_unit, p.category AS product_category
         FROM bill_items bi
         JOIN products p ON p.id = bi.product_id
         WHERE bi.bill_id = ? AND bi.user_id = ? AND p.user_id = ?
         ORDER BY bi.id ASC`,
        [req.params.id, req.user.id, req.user.id]
      );

      return res.json({ ok: true, data: { ...bill, items } });
    } catch (err) {
      next(err);
    }
  }
);




const billValidation = [
  body("date").isISO8601().withMessage("Invalid date"),
  body("term").isIn(["CASH", "CARD", "UPI", "CREDIT"]).withMessage("Invalid payment term"),
  body("vendor_id").isInt({ min: 1 }).withMessage("Vendor is required"),
  body("vendor_invoice_number").trim().notEmpty().withMessage("Vendor invoice number is required"),
  body("discount").optional().isFloat({ min: 0 }).withMessage("Discount must be non-negative"),
  body("items").isArray({ min: 1 }).withMessage("At least one item is required"),
  body("items.*.product_id").isInt({ min: 1 }).withMessage("Invalid product"),
  body("items.*.rate").isFloat({ min: 0.01 }).withMessage("Rate must be positive"),
  body("items.*.quantity").isFloat({ min: 0.01 }).withMessage("Quantity must be positive"),
];




router.post(
  "/",
  requirePermission("can_add_bills"),
  billValidation,
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const {
        date, term, vendor_id, vendor_invoice_number,
        notes = null, discount: rawDiscount = 0, paid_amount: rawPaidAmount = 0, items: rawItems,
      } = req.body;

      const discount   = round2(Number(rawDiscount));
      const paidAmount = round2(Number(rawPaidAmount));

      
      const [[vendor]] = await conn.execute(
        "SELECT id, name, balance FROM vendors WHERE id = ? AND user_id = ? AND is_active = 1",
        [vendor_id, req.user.id]
      );
      if (!vendor) {
        await conn.rollback();
        return res.status(422).json({ ok: false, error: "Vendor not found" });
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
        const { value, taxValue, total } = calcItemTotals(rate, quantity, taxRate);

        processedItems.push({
          product_id: product.id, rate, quantity, value,
          tax_rate: taxRate, tax_value: taxValue, total_value: total,
        });
      }

      const { subTotal, totalTax, roundOff, grandTotal } = calcBillTotals(processedItems, discount);
      const amountInWords = numberToWords(grandTotal);
      const previousBalance = round2(Number(vendor.balance || 0));
      const netPayable = round2(grandTotal - previousBalance);
      const balance = round2(previousBalance + paidAmount - grandTotal);
      const status  = balance >= -0.01 ? "PAID" : (paidAmount > 0 ? "PARTIAL" : "UNPAID");

      const billCode = await getNextCode(conn, "BILL");

      
      const [billResult] = await conn.execute(
        `INSERT INTO bills
           (user_id, code, number, vendor_invoice_number, date, term, vendor_id,
            sub_total, discount, total_tax, round_off, grand_total,
            amount_in_words, paid_amount, balance, status, notes, previous_balance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.id, billCode, billCode, vendor_invoice_number, date, term, vendor_id,
          subTotal, discount, totalTax, roundOff, grandTotal,
          amountInWords, paidAmount, balance, status, notes, previousBalance
        ]
      );
      const billId = billResult.insertId;

      // Update vendor balance
      await conn.execute(
        "UPDATE vendors SET balance = balance + ? - ? WHERE id = ?",
        [paidAmount, grandTotal, vendor_id]
      );

      
      for (const item of processedItems) {
        await conn.execute(
          `INSERT INTO bill_items
             (user_id, bill_id, product_id, rate, quantity, value, tax_rate, tax_value, total_value)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [req.user.id, billId, item.product_id, item.rate, item.quantity, item.value, item.tax_rate, item.tax_value, item.total_value]
        );

        const stockCode = await getNextCode(conn, "INVENTORY");
        await adjustStock(conn, {
          userId:         req.user.id,
          productId:     item.product_id,
          adjustment:    +item.quantity,       
          type:          "PURCHASE",
          reason:        `Purchase — Bill ${billCode}`,
          refId:         billId,
          refCode:       billCode,
          inventoryCode: stockCode,
        });
      }

      await logActivity(conn, {
        userId:      req.user.id,
        type:        "BILL_CREATED",
        entityId:    billId,
        entityCode:  billCode,
        description: `Bill ${billCode} created for ${vendor.name} — ₹${grandTotal}`,
      });

      await conn.commit();

      const [[created]] = await pool.execute(
        `SELECT b.*, v.name AS vendor_name
         FROM bills b
         JOIN vendors v ON v.id = b.vendor_id
         WHERE b.id = ? AND b.user_id = ? AND v.user_id = ?`,
        [billId, req.user.id, req.user.id]
      );

      return res.status(201).json({ ok: true, data: created, message: "Bill created successfully" });
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
  requirePermission("can_edit_bills"),
  [param("id").isInt().toInt(), ...billValidation],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const billId = req.params.id;

      const [[existing]] = await conn.execute(
        "SELECT * FROM bills WHERE id = ? AND user_id = ? FOR UPDATE",
        [billId, req.user.id]
      );
      if (!existing) {
        await conn.rollback();
        return res.status(404).json({ ok: false, error: "Bill not found" });
      }

      const [oldItems] = await conn.execute(
        "SELECT * FROM bill_items WHERE bill_id = ? AND user_id = ?",
        [billId, req.user.id]
      );

      const {
        date, term, vendor_id, vendor_invoice_number,
        notes = null, discount: rawDiscount = 0, paid_amount: rawPaidAmount = 0, items: rawItems,
      } = req.body;

      const discount   = round2(Number(rawDiscount));
      const paidAmount = round2(Number(rawPaidAmount));

      const [[vendor]] = await conn.execute(
        "SELECT id, name FROM vendors WHERE id = ? AND user_id = ? AND is_active = 1",
        [vendor_id, req.user.id]
      );
      if (!vendor) {
        await conn.rollback();
        return res.status(422).json({ ok: false, error: "Vendor not found" });
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
        const { value, taxValue, total } = calcItemTotals(rate, quantity, taxRate);
        processedItems.push({ product_id: product.id, rate, quantity, value, tax_rate: taxRate, tax_value: taxValue, total_value: total });
      }

      
      for (const old of oldItems) {
        const stockCode = await getNextCode(conn, "INVENTORY");
        await adjustStock(conn, {
          userId:         req.user.id,
          productId:     old.product_id,
          adjustment:    -Number(old.quantity),   
          type:          "PURCHASE_RETURN",
          reason:        `Edit reversal — Bill ${existing.code}`,
          refId:         billId,
          refCode:       existing.code,
          inventoryCode: stockCode,
        });
      }

      
      for (const item of processedItems) {
        const stockCode = await getNextCode(conn, "INVENTORY");
        await adjustStock(conn, {
          userId:         req.user.id,
          productId:     item.product_id,
          adjustment:    +item.quantity,
          type:          "PURCHASE",
          reason:        `Purchase (edited) — Bill ${existing.code}`,
          refId:         billId,
          refCode:       existing.code,
          inventoryCode: stockCode,
        });
      }

      const { subTotal, totalTax, roundOff, grandTotal } = calcBillTotals(processedItems, discount);
      const amountInWords = numberToWords(grandTotal);
      const previousBalance = round2(Number(existing.previous_balance || 0));
      const netPayable = round2(grandTotal - previousBalance);
      const balance       = round2(previousBalance + paidAmount - grandTotal);
      const status        = balance >= -0.01 ? "PAID" : (paidAmount > 0 ? "PARTIAL" : "UNPAID");

      // Update vendor balance
      const oldEffect = round2(Number(existing.paid_amount) - Number(existing.grand_total));
      const newEffect = round2(paidAmount - grandTotal);
      
      if (existing.vendor_id === vendor_id) {
        const deltaEffect = round2(newEffect - oldEffect);
        await conn.execute("UPDATE vendors SET balance = balance + ? WHERE id = ?", [deltaEffect, vendor_id]);
      } else {
        await conn.execute("UPDATE vendors SET balance = balance - ? WHERE id = ?", [oldEffect, existing.vendor_id]);
        await conn.execute("UPDATE vendors SET balance = balance + ? WHERE id = ?", [newEffect, vendor_id]);
      }

      await conn.execute(
        `UPDATE bills SET
           date = ?, term = ?, vendor_id = ?, vendor_invoice_number = ?,
           sub_total = ?, discount = ?, total_tax = ?, round_off = ?,
           grand_total = ?, amount_in_words = ?, paid_amount = ?, balance = ?, status = ?, notes = ?
         WHERE id = ? AND user_id = ?`,
        [
          date, term, vendor_id, vendor_invoice_number,
          subTotal, discount, totalTax, roundOff,
          grandTotal, amountInWords, paidAmount, balance, status, notes,
          billId, req.user.id,
        ]
      );

      await conn.execute("DELETE FROM bill_items WHERE bill_id = ? AND user_id = ?", [billId, req.user.id]);
      for (const item of processedItems) {
        await conn.execute(
          `INSERT INTO bill_items (user_id, bill_id, product_id, rate, quantity, value, tax_rate, tax_value, total_value)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [req.user.id, billId, item.product_id, item.rate, item.quantity, item.value, item.tax_rate, item.tax_value, item.total_value]
        );
      }

      await logActivity(conn, {
        userId:      req.user.id,
        type:        "BILL_UPDATED",
        entityId:    billId,
        entityCode:  existing.code,
        description: `Bill ${existing.code} updated — ₹${grandTotal}`,
      });

      await conn.commit();
      return res.json({ ok: true, message: "Bill updated successfully" });
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
  requirePermission("can_delete_bills"),
  [param("id").isInt().toInt()],
  async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[bill]] = await conn.execute(
        "SELECT * FROM bills WHERE id = ? AND user_id = ? FOR UPDATE",
        [req.params.id, req.user.id]
      );
      if (!bill) {
        await conn.rollback();
        return res.status(404).json({ ok: false, error: "Bill not found" });
      }

      const [items] = await conn.execute(
        "SELECT * FROM bill_items WHERE bill_id = ? AND user_id = ?",
        [req.params.id, req.user.id]
      );

      
      for (const item of items) {
        const stockCode = await getNextCode(conn, "INVENTORY");
        await adjustStock(conn, {
          userId:         req.user.id,
          productId:     item.product_id,
          adjustment:    -Number(item.quantity),    
          type:          "PURCHASE_RETURN",
          reason:        `Bill deleted — ${bill.code}`,
          refId:         bill.id,
          refCode:       bill.code,
          inventoryCode: stockCode,
        });
      }

      const oldEffect = round2(Number(bill.paid_amount) - Number(bill.grand_total));
      await conn.execute(
        "UPDATE vendors SET balance = balance - ? WHERE id = ?",
        [oldEffect, bill.vendor_id]
      );

      await conn.execute("DELETE FROM bills WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);

      await logActivity(conn, {
        userId:      req.user.id,
        type:        "BILL_DELETED",
        entityId:    bill.id,
        entityCode:  bill.code,
        description: `Bill ${bill.code} deleted — stock reversed`,
      });

      await conn.commit();
      return res.json({ ok: true, message: "Bill deleted and stock reversed" });
    } catch (err) {
      await conn.rollback();
      next(err);
    } finally {
      conn.release();
    }
  }
);

module.exports = router;
