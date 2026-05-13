const router = require("express").Router();
const { pool, getNextCode, adjustStock, logActivity } = require("../config/db");
const { body, param, query, validationResult } = require("express-validator");
const { numberToWords } = require("../utils/helpers");
const { requirePermission } = require("../middleware/permissions");
const { loadCompanyProfile } = require("../utils/tenancy");
const { ensureProductSchemaCompatibility } = require("../utils/productSchema");
const { ensureInvoiceSchemaCompatibility } = require("../utils/transactionSchema");
const {
  calculateInvoiceTaxes,
  cleanOptional,
  deriveStateFromGstin,
  findStateByCode,
  findStateByName,
  isValidGstRate,
  isIndianCountry,
  normalizeCountry,
  normalizeStateCode,
  round2,
} = require("../utils/gst");

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

function getInvoiceStatus(balance, paidAmount) {
  if (balance >= -0.01) {
    return "PAID";
  }
  return paidAmount > 0 ? "PARTIAL" : "UNPAID";
}

async function getCustomerRecord(conn, customerId, userId, { forUpdate = false } = {}) {
  const lockClause = forUpdate ? " FOR UPDATE" : "";
  const [[customer]] = await conn.execute(
    `SELECT
       id,
       name,
       salutation,
       mobile,
       address,
       billing_address,
       shipping_address,
       email,
       gstin,
       country,
       state_name,
       state_code,
       balance
     FROM customers
     WHERE id = ? AND user_id = ?${lockClause}`,
    [customerId, userId]
  );

  return customer || null;
}

async function getCompanyTaxProfile(conn, companyId) {
  const company = await loadCompanyProfile(conn, companyId);
  if (!company) {
    const error = new Error("Company profile not found");
    error.status = 422;
    throw error;
  }

  const derivedState = deriveStateFromGstin(company.gstin);

  return {
    ...company,
    state_code: normalizeStateCode(company.state_code || derivedState?.code),
    state_name: cleanOptional(company.state_name) || derivedState?.name || null,
  };
}

function resolvePlaceOfSupply(customer, company, payload) {
  const customerCountry = normalizeCountry(customer.country);
  const exportFlag = Boolean(payload.is_export) || !isIndianCountry(customerCountry);

  if (!exportFlag && !company.state_code) {
    const error = new Error("Company GSTIN and state must be configured before creating domestic tax invoices");
    error.status = 422;
    throw error;
  }

  if (exportFlag) {
    return {
      isExport: true,
      supplyType: "EXPORT",
      customerCountry,
      placeOfSupplyCountry: customerCountry,
      placeOfSupplyStateCode: normalizeStateCode(payload.place_of_supply_state_code) || null,
      placeOfSupplyStateName: cleanOptional(payload.place_of_supply_state_name) || null,
    };
  }

  const requestedState =
    findStateByCode(payload.place_of_supply_state_code) ||
    findStateByName(payload.place_of_supply_state_name) ||
    findStateByCode(customer.state_code) ||
    findStateByName(customer.state_name);

  if (!requestedState) {
    const error = new Error("Place of supply is required for domestic invoices");
    error.status = 422;
    throw error;
  }

  const placeOfSupplyStateCode = normalizeStateCode(requestedState.code);
  const supplyType = company.state_code === placeOfSupplyStateCode ? "INTRA_STATE" : "INTER_STATE";

  return {
    isExport: false,
    supplyType,
    customerCountry,
    placeOfSupplyCountry: "India",
    placeOfSupplyStateCode,
    placeOfSupplyStateName: requestedState.name,
  };
}

async function buildProcessedItems(conn, userId, rawItems, invoiceContext) {
  await ensureInvoiceSchemaCompatibility(conn);
  await ensureProductSchemaCompatibility(conn);
  const seededItems = [];

  for (const item of rawItems) {
    const [[product]] = await conn.execute(
      `SELECT id, name, tax_rate, hsn_sac_code, product_type, product_tag
       FROM products
       WHERE id = ? AND user_id = ? AND is_active = 1`,
      [item.product_id, userId]
    );

    if (!product) {
      const error = new Error(`Product #${item.product_id} not found`);
      error.status = 422;
      throw error;
    }

    const overrideTaxRate = item.tax_rate != null && item.tax_rate !== ""
      ? round2(Number(item.tax_rate))
      : round2(Number(product.tax_rate));
    const overrideHsnSacCode = cleanOptional(item.hsn_sac_code) || cleanOptional(product.hsn_sac_code) || "";

    seededItems.push({
      product_id: product.id,
      rate: round2(Number(item.rate)),
      quantity: round2(Number(item.quantity)),
      gstRate: overrideTaxRate,
      hsnSacCode: overrideHsnSacCode.toUpperCase(),
      productType: cleanOptional(product.product_type) || "TRADING_GOODS",
      product_tag: product.product_tag,
    });
  }

  const calculations = calculateInvoiceTaxes({
    items: seededItems,
    discount: round2(Number(invoiceContext.discount || 0)),
    companyStateCode: invoiceContext.companyStateCode,
    placeOfSupplyStateCode: invoiceContext.placeOfSupplyStateCode,
    isExport: invoiceContext.isExport,
    priceIncludesGst: invoiceContext.priceIncludesGst,
  });

  const items = calculations.items.map((item) => ({
    product_id: item.product_id,
    hsn_sac_code: item.hsnSacCode,
    product_tag: item.product_tag,
    rate: item.exclusiveRate,
    quantity: item.quantity,
    base_value: item.baseValue,
    discount_value: item.discountValue,
    taxable_value: item.taxableValue,
    value: item.value,
    tax_rate: item.taxRate,
    cgst_rate: item.cgstRate,
    cgst_amount: item.cgstAmount,
    sgst_rate: item.sgstRate,
    sgst_amount: item.sgstAmount,
    igst_rate: item.igstRate,
    igst_amount: item.igstAmount,
    tax_value: item.taxValue,
    total_value: item.totalValue,
  }));

  return {
    items,
    supplyType: calculations.supplyType,
    totals: calculations.totals,
  };
}

const invoiceValidation = [
  body("date").isISO8601().withMessage("Invalid date"),
  body("term").isIn(["CASH", "CARD", "UPI", "CREDIT"]).withMessage("Invalid payment term"),
  body("customer_id").isInt({ min: 1 }).withMessage("Customer is required"),
  body("discount").optional().isFloat({ min: 0 }).withMessage("Discount must be non-negative"),
  body("discount_type").optional().isIn(["PERCENTAGE", "AMOUNT"]).withMessage("Invalid discount type"),
  body("discount_input").optional().isFloat({ min: 0 }).withMessage("Discount input must be non-negative"),
  body("paid_amount").optional().isFloat({ min: 0 }).withMessage("Paid amount must be non-negative"),
  body("notes").optional({ checkFalsy: true }).trim(),
  body("is_export").optional().isBoolean().toBoolean(),
  body("price_includes_gst").optional().isBoolean().toBoolean(),
  body("place_of_supply_state_code").optional({ checkFalsy: true }).trim(),
  body("place_of_supply_state_name").optional({ checkFalsy: true }).trim(),
  body("items").isArray({ min: 1 }).withMessage("At least one item is required"),
  body("items.*.product_id").isInt({ min: 1 }).withMessage("Invalid product"),
  body("items.*.hsn_sac_code").optional({ checkFalsy: true }).trim(),
  body("items.*.tax_rate")
    .optional({ checkFalsy: true })
    .custom((value) => isValidGstRate(value))
    .withMessage("GST rate must be between 0 and 100 with up to 3 decimal places"),
  body("items.*.rate").isFloat({ min: 0.01 }).withMessage("Rate must be positive"),
  body("items.*.quantity").isFloat({ min: 0.01 }).withMessage("Quantity must be positive"),
];

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
      await ensureInvoiceSchemaCompatibility(pool);
      const page = req.query.page || 1;
      const pageSize = req.query.pageSize || 20;
      const offset = (page - 1) * pageSize;
      const search = req.query.search || "";
      const status = req.query.status || null;
      const from = req.query.from || null;
      const to = req.query.to || null;

      const where = ["i.user_id = ?"];
      const params = [req.user.id];

      if (search) {
        const like = `%${search}%`;
        where.push("(i.code LIKE ? OR i.number LIKE ? OR COALESCE(i.customer_name, c.name) LIKE ?)");
        params.push(like, like, like);
      }
      if (status) {
        where.push("i.status = ?");
        params.push(status);
      }
      if (from) {
        where.push("i.date >= ?");
        params.push(from);
      }
      if (to) {
        where.push("i.date <= ?");
        params.push(to);
      }

      const whereClause = where.join(" AND ");

      const [rows] = await pool.execute(
        `SELECT
           i.id,
           i.code,
           i.number,
           i.date,
           i.term,
           i.grand_total,
           i.paid_amount,
           i.balance,
           i.status,
           i.supply_type,
           COALESCE(i.customer_name, c.name) AS customer_name,
           COALESCE(i.customer_mobile, c.mobile) AS customer_mobile
         FROM invoices i
         LEFT JOIN customers c
           ON c.id = i.customer_id AND c.user_id = i.user_id
         WHERE ${whereClause}
         ORDER BY i.id DESC
         LIMIT ${parseInt(pageSize, 10)} OFFSET ${parseInt(offset, 10)}`,
        params
      );

      const [[countRow]] = await pool.execute(
        `SELECT COUNT(*) AS total
         FROM invoices i
         LEFT JOIN customers c
           ON c.id = i.customer_id AND c.user_id = i.user_id
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

router.get(
  "/:id",
  requirePermission("can_view_invoices"),
  [param("id").isInt().toInt()],
  async (req, res, next) => {
    try {
      await ensureInvoiceSchemaCompatibility(pool);
      const [[invoice]] = await pool.execute(
        `SELECT
           i.*,
           COALESCE(i.customer_salutation, c.salutation) AS customer_salutation,
           COALESCE(i.customer_name, c.name) AS customer_name,
           COALESCE(i.customer_mobile, c.mobile) AS customer_mobile,
           COALESCE(i.customer_billing_address, c.billing_address, c.address) AS customer_billing_address,
           COALESCE(i.customer_shipping_address, c.shipping_address, c.billing_address, c.address) AS customer_shipping_address,
           COALESCE(i.customer_email, c.email) AS customer_email,
           COALESCE(i.customer_gstin, c.gstin) AS customer_gstin,
           COALESCE(i.customer_state_name, c.state_name) AS customer_state_name,
           COALESCE(i.customer_state_code, c.state_code) AS customer_state_code,
           COALESCE(i.customer_country, c.country, "India") AS customer_country
         FROM invoices i
         LEFT JOIN customers c
           ON c.id = i.customer_id AND c.user_id = i.user_id
         WHERE i.id = ? AND i.user_id = ?`,
        [req.params.id, req.user.id]
      );

      if (!invoice) {
        return res.status(404).json({ ok: false, error: "Invoice not found" });
      }

      const [items] = await pool.execute(
        `SELECT
           ii.*,
           p.code AS product_code,
           p.name AS product_name,
           p.unit AS product_unit,
           p.category AS product_category,
           COALESCE(ii.hsn_sac_code, p.hsn_sac_code, "") AS line_hsn_sac_code
         FROM invoice_items ii
         LEFT JOIN products p
           ON p.id = ii.product_id AND p.user_id = ii.user_id
         WHERE ii.invoice_id = ? AND ii.user_id = ?
         ORDER BY ii.id ASC`,
        [req.params.id, req.user.id]
      );

      return res.json({ ok: true, data: { ...invoice, items } });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/",
  requirePermission("can_add_invoices"),
  invoiceValidation,
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    const conn = await pool.getConnection();
    try {
      await ensureInvoiceSchemaCompatibility(conn);
      await conn.beginTransaction();

      const {
        customer_id,
        date,
        term,
        notes = null,
        discount: rawDiscount = 0,
        discount_type: discountType = "PERCENTAGE",
        discount_input: rawDiscountInput = 0,
        paid_amount: rawPaidAmount = 0,
        price_includes_gst: priceIncludesGst = false,
        items: rawItems,
      } = req.body;

      const discount = round2(Number(rawDiscount));
      const discountInput = round2(Number(rawDiscountInput));
      const paidAmount = round2(Number(rawPaidAmount));

      const customer = await getCustomerRecord(conn, customer_id, req.user.id, { forUpdate: true });
      if (!customer) {
        await conn.rollback();
        return res.status(422).json({ ok: false, error: "Customer not found" });
      }

      const company = await getCompanyTaxProfile(conn, req.user.company_id);
      const supplyContext = resolvePlaceOfSupply(customer, company, req.body);

      const { items: processedItems, supplyType, totals } = await buildProcessedItems(
        conn,
        req.user.id,
        rawItems,
        {
          discount,
          companyStateCode: company.state_code,
          placeOfSupplyStateCode: supplyContext.placeOfSupplyStateCode,
          isExport: supplyContext.isExport,
          priceIncludesGst: Boolean(priceIncludesGst),
        }
      );

      const previousBalance = round2(Number(customer.balance || 0));
      const balance = round2(previousBalance + paidAmount - totals.grandTotal);
      const status = getInvoiceStatus(balance, paidAmount);
      const invoiceCode = await getNextCode(conn, "INVOICE");

      const [invoiceResult] = await conn.execute(
        `INSERT INTO invoices (
           user_id, code, number, date, term, customer_id,
           customer_salutation, customer_name, customer_mobile, customer_email, customer_gstin,
           customer_billing_address, customer_shipping_address, customer_country,
           customer_state_name, customer_state_code,
           place_of_supply_state_name, place_of_supply_state_code, place_of_supply_country,
           company_state_name, company_state_code,
           supply_type, is_export, price_includes_gst,
           sub_total, discount, discount_type, discount_input, taxable_total, total_cgst, total_sgst, total_igst, total_tax,
           round_off, grand_total, amount_in_words, paid_amount, balance, status, notes, previous_balance
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.id,
          invoiceCode,
          invoiceCode,
          date,
          term,
          customer_id,
          customer.salutation,
          customer.name,
          customer.mobile,
          cleanOptional(customer.email),
          cleanOptional(customer.gstin),
          cleanOptional(customer.billing_address) || customer.address,
          cleanOptional(customer.shipping_address) || cleanOptional(customer.billing_address) || customer.address,
          normalizeCountry(customer.country),
          cleanOptional(customer.state_name),
          normalizeStateCode(customer.state_code),
          supplyContext.placeOfSupplyStateName,
          supplyContext.placeOfSupplyStateCode,
          supplyContext.placeOfSupplyCountry,
          company.state_name,
          company.state_code,
          supplyType,
          supplyContext.isExport ? 1 : 0,
          priceIncludesGst ? 1 : 0,
          totals.subTotal,
          discount,
          discountType,
          discountInput,
          totals.taxableTotal,
          totals.totalCgst,
          totals.totalSgst,
          totals.totalIgst,
          totals.totalTax,
          totals.roundOff,
          totals.grandTotal,
          numberToWords(totals.grandTotal),
          paidAmount,
          balance,
          status,
          cleanOptional(notes),
          previousBalance,
        ]
      );

      const invoiceId = invoiceResult.insertId;

      await conn.execute(
        "UPDATE customers SET balance = ? WHERE id = ? AND user_id = ?",
        [balance, customer_id, req.user.id]
      );

      for (const item of processedItems) {
        await conn.execute(
          `INSERT INTO invoice_items (
             user_id, invoice_id, product_id, hsn_sac_code, product_tag, rate, quantity, base_value,
             discount_value, taxable_value, value, tax_rate, cgst_rate, cgst_amount,
             sgst_rate, sgst_amount, igst_rate, igst_amount, tax_value, total_value
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.user.id,
            invoiceId,
            item.product_id,
            item.hsn_sac_code,
            item.product_tag || null,
            item.rate,
            item.quantity,
            item.base_value,
            item.discount_value,
            item.taxable_value,
            item.value,
            item.tax_rate,
            item.cgst_rate,
            item.cgst_amount,
            item.sgst_rate,
            item.sgst_amount,
            item.igst_rate,
            item.igst_amount,
            item.tax_value,
            item.total_value,
          ]
        );

        const stockCode = await getNextCode(conn, "INVENTORY");
        await adjustStock(conn, {
          userId: req.user.id,
          productId: item.product_id,
          adjustment: -item.quantity,
          type: "SALE",
          reason: `Sale - Invoice ${invoiceCode}`,
          refId: invoiceId,
          refCode: invoiceCode,
          inventoryCode: stockCode,
        });
      }

      await logActivity(conn, {
        userId: req.user.id,
        type: "INVOICE_CREATED",
        entityId: invoiceId,
        entityCode: invoiceCode,
        description: `Invoice ${invoiceCode} created for ${customer.name} - Rs.${totals.grandTotal}`,
      });

      await conn.commit();

      const [[created]] = await pool.execute(
        `SELECT id, code, number, grand_total, status
         FROM invoices
         WHERE id = ? AND user_id = ?`,
        [invoiceId, req.user.id]
      );

      return res.status(201).json({ ok: true, data: created, message: "Invoice created successfully" });
    } catch (error) {
      await conn.rollback();
      if (error.status === 422) {
        return res.status(422).json({ ok: false, error: error.message });
      }
      next(error);
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
      await ensureInvoiceSchemaCompatibility(conn);
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
        "SELECT * FROM invoice_items WHERE invoice_id = ? AND user_id = ? ORDER BY id ASC",
        [invoiceId, req.user.id]
      );

      const {
        customer_id,
        date,
        term,
        notes = null,
        discount: rawDiscount = 0,
        discount_type: discountType = "PERCENTAGE",
        discount_input: rawDiscountInput = 0,
        paid_amount: rawPaidAmount = 0,
        price_includes_gst: priceIncludesGst = false,
        items: rawItems,
      } = req.body;

      const discount = round2(Number(rawDiscount));
      const discountInput = round2(Number(rawDiscountInput));
      const paidAmount = round2(Number(rawPaidAmount));
      const oldEffect = round2(Number(existing.paid_amount) - Number(existing.grand_total));

      const customer = await getCustomerRecord(conn, customer_id, req.user.id, { forUpdate: true });
      if (!customer) {
        await conn.rollback();
        return res.status(422).json({ ok: false, error: "Customer not found" });
      }

      const oldCustomer =
        existing.customer_id === customer_id
          ? customer
          : await getCustomerRecord(conn, existing.customer_id, req.user.id, { forUpdate: true });

      const company = await getCompanyTaxProfile(conn, req.user.company_id);
      const supplyContext = resolvePlaceOfSupply(customer, company, req.body);

      const { items: processedItems, supplyType, totals } = await buildProcessedItems(
        conn,
        req.user.id,
        rawItems,
        {
          discount,
          companyStateCode: company.state_code,
          placeOfSupplyStateCode: supplyContext.placeOfSupplyStateCode,
          isExport: supplyContext.isExport,
          priceIncludesGst: Boolean(priceIncludesGst),
        }
      );

      for (const oldItem of oldItems) {
        const stockCode = await getNextCode(conn, "INVENTORY");
        await adjustStock(conn, {
          userId: req.user.id,
          productId: oldItem.product_id,
          adjustment: Number(oldItem.quantity),
          type: "SALE_RETURN",
          reason: `Edit reversal - Invoice ${existing.code}`,
          refId: invoiceId,
          refCode: existing.code,
          inventoryCode: stockCode,
        });
      }

      for (const item of processedItems) {
        const stockCode = await getNextCode(conn, "INVENTORY");
        await adjustStock(conn, {
          userId: req.user.id,
          productId: item.product_id,
          adjustment: -item.quantity,
          type: "SALE",
          reason: `Sale (edited) - Invoice ${existing.code}`,
          refId: invoiceId,
          refCode: existing.code,
          inventoryCode: stockCode,
        });
      }

      const previousBalance =
        existing.customer_id === customer_id
          ? round2(Number(customer.balance || 0) - oldEffect)
          : round2(Number(customer.balance || 0));

      const newBalance = round2(previousBalance + paidAmount - totals.grandTotal);
      const status = getInvoiceStatus(newBalance, paidAmount);

      if (existing.customer_id === customer_id) {
        await conn.execute(
          "UPDATE customers SET balance = ? WHERE id = ? AND user_id = ?",
          [newBalance, customer_id, req.user.id]
        );
      } else {
        const restoredOldBalance = round2(Number(oldCustomer?.balance || 0) - oldEffect);
        await conn.execute(
          "UPDATE customers SET balance = ? WHERE id = ? AND user_id = ?",
          [restoredOldBalance, existing.customer_id, req.user.id]
        );
        await conn.execute(
          "UPDATE customers SET balance = ? WHERE id = ? AND user_id = ?",
          [newBalance, customer_id, req.user.id]
        );
      }

      await conn.execute(
        `UPDATE invoices
         SET date = ?, term = ?, customer_id = ?,
             customer_salutation = ?, customer_name = ?, customer_mobile = ?, customer_email = ?,
             customer_gstin = ?, customer_billing_address = ?, customer_shipping_address = ?,
             customer_country = ?, customer_state_name = ?, customer_state_code = ?,
             place_of_supply_state_name = ?, place_of_supply_state_code = ?, place_of_supply_country = ?,
             company_state_name = ?, company_state_code = ?,
             supply_type = ?, is_export = ?, price_includes_gst = ?,
             sub_total = ?, discount = ?, discount_type = ?, discount_input = ?, taxable_total = ?, total_cgst = ?, total_sgst = ?,
             total_igst = ?, total_tax = ?, round_off = ?, grand_total = ?, amount_in_words = ?,
             paid_amount = ?, balance = ?, status = ?, notes = ?, previous_balance = ?
         WHERE id = ? AND user_id = ?`,
        [
          date,
          term,
          customer_id,
          customer.salutation,
          customer.name,
          customer.mobile,
          cleanOptional(customer.email),
          cleanOptional(customer.gstin),
          cleanOptional(customer.billing_address) || customer.address,
          cleanOptional(customer.shipping_address) || cleanOptional(customer.billing_address) || customer.address,
          normalizeCountry(customer.country),
          cleanOptional(customer.state_name),
          normalizeStateCode(customer.state_code),
          supplyContext.placeOfSupplyStateName,
          supplyContext.placeOfSupplyStateCode,
          supplyContext.placeOfSupplyCountry,
          company.state_name,
          company.state_code,
          supplyType,
          supplyContext.isExport ? 1 : 0,
          priceIncludesGst ? 1 : 0,
          totals.subTotal,
          discount,
          discountType,
          discountInput,
          totals.taxableTotal,
          totals.totalCgst,
          totals.totalSgst,
          totals.totalIgst,
          totals.totalTax,
          totals.roundOff,
          totals.grandTotal,
          numberToWords(totals.grandTotal),
          paidAmount,
          newBalance,
          status,
          cleanOptional(notes),
          previousBalance,
          invoiceId,
          req.user.id,
        ]
      );

      await conn.execute("DELETE FROM invoice_items WHERE invoice_id = ? AND user_id = ?", [invoiceId, req.user.id]);

      for (const item of processedItems) {
        await conn.execute(
          `INSERT INTO invoice_items (
             user_id, invoice_id, product_id, hsn_sac_code, product_tag, rate, quantity, base_value,
             discount_value, taxable_value, value, tax_rate, cgst_rate, cgst_amount,
             sgst_rate, sgst_amount, igst_rate, igst_amount, tax_value, total_value
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.user.id,
            invoiceId,
            item.product_id,
            item.hsn_sac_code,
            item.product_tag || null,
            item.rate,
            item.quantity,
            item.base_value,
            item.discount_value,
            item.taxable_value,
            item.value,
            item.tax_rate,
            item.cgst_rate,
            item.cgst_amount,
            item.sgst_rate,
            item.sgst_amount,
            item.igst_rate,
            item.igst_amount,
            item.tax_value,
            item.total_value,
          ]
        );
      }

      await logActivity(conn, {
        userId: req.user.id,
        type: "INVOICE_UPDATED",
        entityId: invoiceId,
        entityCode: existing.code,
        description: `Invoice ${existing.code} updated - Rs.${totals.grandTotal}`,
      });

      await conn.commit();
      return res.json({ ok: true, message: "Invoice updated successfully" });
    } catch (error) {
      await conn.rollback();
      if (error.status === 422) {
        return res.status(422).json({ ok: false, error: error.message });
      }
      next(error);
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
      await ensureInvoiceSchemaCompatibility(conn);
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
          userId: req.user.id,
          productId: item.product_id,
          adjustment: Number(item.quantity),
          type: "SALE_RETURN",
          reason: `Invoice deleted - ${invoice.code}`,
          refId: invoice.id,
          refCode: invoice.code,
          inventoryCode: stockCode,
        });
      }

      const oldEffect = round2(Number(invoice.paid_amount) - Number(invoice.grand_total));
      await conn.execute(
        "UPDATE customers SET balance = balance - ? WHERE id = ? AND user_id = ?",
        [oldEffect, invoice.customer_id, req.user.id]
      );

      await conn.execute("DELETE FROM invoices WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);

      await logActivity(conn, {
        userId: req.user.id,
        type: "INVOICE_DELETED",
        entityId: invoice.id,
        entityCode: invoice.code,
        description: `Invoice ${invoice.code} deleted - stock restored`,
      });

      await conn.commit();
      return res.json({ ok: true, message: "Invoice deleted and stock restored" });
    } catch (error) {
      await conn.rollback();
      next(error);
    } finally {
      conn.release();
    }
  }
);

module.exports = router;
