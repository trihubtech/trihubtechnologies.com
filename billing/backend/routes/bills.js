const router = require("express").Router();
const { pool, getNextCode, adjustStock, logActivity } = require("../config/db");
const { body, param, query, validationResult } = require("express-validator");
const { numberToWords } = require("../utils/helpers");
const { requirePermission } = require("../middleware/permissions");
const { loadCompanyProfile } = require("../utils/tenancy");
const { ensureProductSchemaCompatibility } = require("../utils/productSchema");
const { ensureBillSchemaCompatibility } = require("../utils/transactionSchema");
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

function getBillStatus(balance, paidAmount) {
  if (balance >= -0.01) {
    return "PAID";
  }
  return paidAmount > 0 ? "PARTIAL" : "UNPAID";
}

async function getVendorRecord(conn, vendorId, userId, { forUpdate = false } = {}) {
  const lockClause = forUpdate ? " FOR UPDATE" : "";
  const [[vendor]] = await conn.execute(
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
     FROM vendors
     WHERE id = ? AND user_id = ?${lockClause}`,
    [vendorId, userId]
  );

  return vendor || null;
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

function resolvePlaceOfSupply(vendor, company, payload) {
  const vendorCountry = normalizeCountry(vendor.country);
  const importFlag = Boolean(payload.is_import) || !isIndianCountry(vendorCountry);

  if (!importFlag && !company.state_code) {
    const error = new Error("Company GSTIN and state must be configured before creating domestic purchase bills");
    error.status = 422;
    throw error;
  }

  if (importFlag) {
    return {
      isImport: true,
      supplyType: "IMPORT",
      vendorCountry,
      placeOfSupplyCountry: vendorCountry,
      placeOfSupplyStateCode: normalizeStateCode(payload.place_of_supply_state_code) || null,
      placeOfSupplyStateName: cleanOptional(payload.place_of_supply_state_name) || null,
    };
  }

  const requestedState =
    findStateByCode(payload.place_of_supply_state_code) ||
    findStateByName(payload.place_of_supply_state_name) ||
    findStateByCode(vendor.state_code) ||
    findStateByName(vendor.state_name);

  if (!requestedState) {
    const error = new Error("Place of supply is required for domestic purchase bills");
    error.status = 422;
    throw error;
  }

  const placeOfSupplyStateCode = normalizeStateCode(requestedState.code);
  const supplyType = company.state_code === placeOfSupplyStateCode ? "INTRA_STATE" : "INTER_STATE";

  return {
    isImport: false,
    supplyType,
    vendorCountry,
    placeOfSupplyCountry: "India",
    placeOfSupplyStateCode,
    placeOfSupplyStateName: requestedState.name,
  };
}

async function buildProcessedItems(conn, userId, rawItems, billContext) {
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
    discount: round2(Number(billContext.discount || 0)),
    companyStateCode: billContext.companyStateCode,
    placeOfSupplyStateCode: billContext.placeOfSupplyStateCode,
    isExport: billContext.isImport,
    priceIncludesGst: billContext.priceIncludesGst,
    internationalSupplyType: "IMPORT",
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

const billValidation = [
  body("date").isISO8601().withMessage("Invalid date"),
  body("term").isIn(["CASH", "CARD", "UPI", "CREDIT"]).withMessage("Invalid payment term"),
  body("vendor_id").isInt({ min: 1 }).withMessage("Vendor is required"),
  body("vendor_invoice_number").trim().notEmpty().withMessage("Vendor invoice number is required"),
  body("discount").optional().isFloat({ min: 0 }).withMessage("Discount must be non-negative"),
  body("discount_type").optional().isIn(["PERCENTAGE", "AMOUNT"]).withMessage("Invalid discount type"),
  body("discount_input").optional().isFloat({ min: 0 }).withMessage("Discount input must be non-negative"),
  body("paid_amount").optional().isFloat({ min: 0 }).withMessage("Paid amount must be non-negative"),
  body("notes").optional({ checkFalsy: true }).trim(),
  body("is_import").optional().isBoolean().toBoolean(),
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
      await ensureBillSchemaCompatibility(pool);
      const page = req.query.page || 1;
      const pageSize = req.query.pageSize || 20;
      const offset = (page - 1) * pageSize;
      const search = req.query.search || "";
      const status = req.query.status || null;
      const from = req.query.from || null;
      const to = req.query.to || null;

      const where = ["b.user_id = ?"];
      const params = [req.user.id];

      if (search) {
        const like = `%${search}%`;
        where.push("(b.code LIKE ? OR b.number LIKE ? OR b.vendor_invoice_number LIKE ? OR COALESCE(b.vendor_name, v.name) LIKE ?)");
        params.push(like, like, like, like);
      }
      if (status) {
        where.push("b.status = ?");
        params.push(status);
      }
      if (from) {
        where.push("b.date >= ?");
        params.push(from);
      }
      if (to) {
        where.push("b.date <= ?");
        params.push(to);
      }

      const whereClause = where.join(" AND ");

      const [rows] = await pool.execute(
        `SELECT
           b.id,
           b.code,
           b.number,
           b.vendor_invoice_number,
           b.date,
           b.term,
           b.grand_total,
           b.paid_amount,
           b.balance,
           b.status,
           b.supply_type,
           COALESCE(b.vendor_name, v.name) AS vendor_name,
           COALESCE(b.vendor_mobile, v.mobile) AS vendor_mobile
         FROM bills b
         LEFT JOIN vendors v
           ON v.id = b.vendor_id AND v.user_id = b.user_id
         WHERE ${whereClause}
         ORDER BY b.id DESC
         LIMIT ${parseInt(pageSize, 10)} OFFSET ${parseInt(offset, 10)}`,
        params
      );

      const [[countRow]] = await pool.execute(
        `SELECT COUNT(*) AS total
         FROM bills b
         LEFT JOIN vendors v
           ON v.id = b.vendor_id AND v.user_id = b.user_id
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
  requirePermission("can_view_bills"),
  [param("id").isInt().toInt()],
  async (req, res, next) => {
    try {
      await ensureBillSchemaCompatibility(pool);
      const [[bill]] = await pool.execute(
        `SELECT
           b.*,
           COALESCE(v.code, '') AS vendor_code,
           COALESCE(b.vendor_salutation, v.salutation) AS vendor_salutation,
           COALESCE(b.vendor_name, v.name) AS vendor_name,
           COALESCE(b.vendor_mobile, v.mobile) AS vendor_mobile,
           COALESCE(b.vendor_billing_address, v.billing_address, v.address) AS vendor_billing_address,
           COALESCE(b.vendor_shipping_address, v.shipping_address, v.billing_address, v.address) AS vendor_shipping_address,
           COALESCE(b.vendor_email, v.email) AS vendor_email,
           COALESCE(b.vendor_gstin, v.gstin) AS vendor_gstin,
           COALESCE(b.vendor_state_name, v.state_name) AS vendor_state_name,
           COALESCE(b.vendor_state_code, v.state_code) AS vendor_state_code,
           COALESCE(b.vendor_country, v.country, 'India') AS vendor_country
         FROM bills b
         LEFT JOIN vendors v
           ON v.id = b.vendor_id AND v.user_id = b.user_id
         WHERE b.id = ? AND b.user_id = ?`,
        [req.params.id, req.user.id]
      );

      if (!bill) {
        return res.status(404).json({ ok: false, error: "Bill not found" });
      }

      const [items] = await pool.execute(
        `SELECT
           bi.*,
           p.code AS product_code,
           p.name AS product_name,
           p.unit AS product_unit,
           p.category AS product_category,
           COALESCE(bi.hsn_sac_code, p.hsn_sac_code, '') AS line_hsn_sac_code
         FROM bill_items bi
         LEFT JOIN products p
           ON p.id = bi.product_id AND p.user_id = bi.user_id
         WHERE bi.bill_id = ? AND bi.user_id = ?
         ORDER BY bi.id ASC`,
        [req.params.id, req.user.id]
      );

      return res.json({ ok: true, data: { ...bill, items } });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/",
  requirePermission("can_add_bills"),
  billValidation,
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    const conn = await pool.getConnection();
    try {
      await ensureBillSchemaCompatibility(conn);
      await conn.beginTransaction();

      const {
        date,
        term,
        vendor_id,
        vendor_invoice_number,
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

      const vendor = await getVendorRecord(conn, vendor_id, req.user.id, { forUpdate: true });
      if (!vendor) {
        await conn.rollback();
        return res.status(422).json({ ok: false, error: "Vendor not found" });
      }

      const company = await getCompanyTaxProfile(conn, req.user.company_id);
      const supplyContext = resolvePlaceOfSupply(vendor, company, req.body);

      const { items: processedItems, supplyType, totals } = await buildProcessedItems(
        conn,
        req.user.id,
        rawItems,
        {
          discount,
          companyStateCode: company.state_code,
          placeOfSupplyStateCode: supplyContext.placeOfSupplyStateCode,
          isImport: supplyContext.isImport,
          priceIncludesGst: Boolean(priceIncludesGst),
        }
      );

      const previousBalance = round2(Number(vendor.balance || 0));
      const balance = round2(previousBalance + paidAmount - totals.grandTotal);
      const status = getBillStatus(balance, paidAmount);
      const billCode = await getNextCode(conn, "BILL");

      const [billResult] = await conn.execute(
        `INSERT INTO bills (
           user_id, code, number, vendor_invoice_number, date, term, vendor_id,
           vendor_salutation, vendor_name, vendor_mobile, vendor_email, vendor_gstin,
           vendor_billing_address, vendor_shipping_address, vendor_country,
           vendor_state_name, vendor_state_code,
           place_of_supply_state_name, place_of_supply_state_code, place_of_supply_country,
           company_state_name, company_state_code,
           supply_type, is_import, price_includes_gst,
           sub_total, discount, discount_type, discount_input, taxable_total, total_cgst, total_sgst, total_igst, total_tax,
           round_off, grand_total, amount_in_words, paid_amount, balance, status, notes, previous_balance
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.id,
          billCode,
          billCode,
          vendor_invoice_number,
          date,
          term,
          vendor_id,
          vendor.salutation,
          vendor.name,
          vendor.mobile,
          cleanOptional(vendor.email),
          cleanOptional(vendor.gstin),
          cleanOptional(vendor.billing_address) || vendor.address,
          cleanOptional(vendor.shipping_address) || cleanOptional(vendor.billing_address) || vendor.address,
          normalizeCountry(vendor.country),
          cleanOptional(vendor.state_name),
          normalizeStateCode(vendor.state_code),
          supplyContext.placeOfSupplyStateName,
          supplyContext.placeOfSupplyStateCode,
          supplyContext.placeOfSupplyCountry,
          company.state_name,
          company.state_code,
          supplyType,
          supplyContext.isImport ? 1 : 0,
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

      const billId = billResult.insertId;

      await conn.execute(
        "UPDATE vendors SET balance = ? WHERE id = ? AND user_id = ?",
        [balance, vendor_id, req.user.id]
      );

      for (const item of processedItems) {
        await conn.execute(
          `INSERT INTO bill_items (
             user_id, bill_id, product_id, hsn_sac_code, product_tag, rate, quantity, base_value,
             discount_value, taxable_value, value, tax_rate, cgst_rate, cgst_amount,
             sgst_rate, sgst_amount, igst_rate, igst_amount, tax_value, total_value
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.user.id,
            billId,
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
          adjustment: +item.quantity,
          type: "PURCHASE",
          reason: `Purchase - Bill ${billCode}`,
          refId: billId,
          refCode: billCode,
          inventoryCode: stockCode,
        });
      }

      await logActivity(conn, {
        userId: req.user.id,
        type: "BILL_CREATED",
        entityId: billId,
        entityCode: billCode,
        description: `Bill ${billCode} created for ${vendor.name} - Rs.${totals.grandTotal}`,
      });

      await conn.commit();

      const [[created]] = await pool.execute(
        `SELECT id, code, number, grand_total, status
         FROM bills
         WHERE id = ? AND user_id = ?`,
        [billId, req.user.id]
      );

      return res.status(201).json({ ok: true, data: created, message: "Bill created successfully" });
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
  requirePermission("can_edit_bills"),
  [param("id").isInt().toInt(), ...billValidation],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    const conn = await pool.getConnection();
    try {
      await ensureBillSchemaCompatibility(conn);
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
        "SELECT * FROM bill_items WHERE bill_id = ? AND user_id = ? ORDER BY id ASC",
        [billId, req.user.id]
      );

      const {
        date,
        term,
        vendor_id,
        vendor_invoice_number,
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

      const vendor = await getVendorRecord(conn, vendor_id, req.user.id, { forUpdate: true });
      if (!vendor) {
        await conn.rollback();
        return res.status(422).json({ ok: false, error: "Vendor not found" });
      }

      const oldVendor =
        existing.vendor_id === vendor_id
          ? vendor
          : await getVendorRecord(conn, existing.vendor_id, req.user.id, { forUpdate: true });

      const company = await getCompanyTaxProfile(conn, req.user.company_id);
      const supplyContext = resolvePlaceOfSupply(vendor, company, req.body);

      const { items: processedItems, supplyType, totals } = await buildProcessedItems(
        conn,
        req.user.id,
        rawItems,
        {
          discount,
          companyStateCode: company.state_code,
          placeOfSupplyStateCode: supplyContext.placeOfSupplyStateCode,
          isImport: supplyContext.isImport,
          priceIncludesGst: Boolean(priceIncludesGst),
        }
      );

      for (const oldItem of oldItems) {
        const stockCode = await getNextCode(conn, "INVENTORY");
        await adjustStock(conn, {
          userId: req.user.id,
          productId: oldItem.product_id,
          adjustment: -Number(oldItem.quantity),
          type: "PURCHASE_RETURN",
          reason: `Edit reversal - Bill ${existing.code}`,
          refId: billId,
          refCode: existing.code,
          inventoryCode: stockCode,
        });
      }

      for (const item of processedItems) {
        const stockCode = await getNextCode(conn, "INVENTORY");
        await adjustStock(conn, {
          userId: req.user.id,
          productId: item.product_id,
          adjustment: +item.quantity,
          type: "PURCHASE",
          reason: `Purchase (edited) - Bill ${existing.code}`,
          refId: billId,
          refCode: existing.code,
          inventoryCode: stockCode,
        });
      }

      const previousBalance =
        existing.vendor_id === vendor_id
          ? round2(Number(vendor.balance || 0) - oldEffect)
          : round2(Number(vendor.balance || 0));

      const newBalance = round2(previousBalance + paidAmount - totals.grandTotal);
      const status = getBillStatus(newBalance, paidAmount);

      if (existing.vendor_id === vendor_id) {
        await conn.execute(
          "UPDATE vendors SET balance = ? WHERE id = ? AND user_id = ?",
          [newBalance, vendor_id, req.user.id]
        );
      } else {
        const restoredOldBalance = round2(Number(oldVendor?.balance || 0) - oldEffect);
        await conn.execute(
          "UPDATE vendors SET balance = ? WHERE id = ? AND user_id = ?",
          [restoredOldBalance, existing.vendor_id, req.user.id]
        );
        await conn.execute(
          "UPDATE vendors SET balance = ? WHERE id = ? AND user_id = ?",
          [newBalance, vendor_id, req.user.id]
        );
      }

      await conn.execute(
        `UPDATE bills
         SET date = ?, term = ?, vendor_id = ?, vendor_invoice_number = ?,
             vendor_salutation = ?, vendor_name = ?, vendor_mobile = ?, vendor_email = ?,
             vendor_gstin = ?, vendor_billing_address = ?, vendor_shipping_address = ?,
             vendor_country = ?, vendor_state_name = ?, vendor_state_code = ?,
             place_of_supply_state_name = ?, place_of_supply_state_code = ?, place_of_supply_country = ?,
             company_state_name = ?, company_state_code = ?,
             supply_type = ?, is_import = ?, price_includes_gst = ?,
             sub_total = ?, discount = ?, discount_type = ?, discount_input = ?, taxable_total = ?, total_cgst = ?, total_sgst = ?,
             total_igst = ?, total_tax = ?, round_off = ?, grand_total = ?, amount_in_words = ?,
             paid_amount = ?, balance = ?, status = ?, notes = ?, previous_balance = ?
         WHERE id = ? AND user_id = ?`,
        [
          date,
          term,
          vendor_id,
          vendor_invoice_number,
          vendor.salutation,
          vendor.name,
          vendor.mobile,
          cleanOptional(vendor.email),
          cleanOptional(vendor.gstin),
          cleanOptional(vendor.billing_address) || vendor.address,
          cleanOptional(vendor.shipping_address) || cleanOptional(vendor.billing_address) || vendor.address,
          normalizeCountry(vendor.country),
          cleanOptional(vendor.state_name),
          normalizeStateCode(vendor.state_code),
          supplyContext.placeOfSupplyStateName,
          supplyContext.placeOfSupplyStateCode,
          supplyContext.placeOfSupplyCountry,
          company.state_name,
          company.state_code,
          supplyType,
          supplyContext.isImport ? 1 : 0,
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
          billId,
          req.user.id,
        ]
      );

      await conn.execute("DELETE FROM bill_items WHERE bill_id = ? AND user_id = ?", [billId, req.user.id]);

      for (const item of processedItems) {
        await conn.execute(
          `INSERT INTO bill_items (
             user_id, bill_id, product_id, hsn_sac_code, product_tag, rate, quantity, base_value,
             discount_value, taxable_value, value, tax_rate, cgst_rate, cgst_amount,
             sgst_rate, sgst_amount, igst_rate, igst_amount, tax_value, total_value
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.user.id,
            billId,
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
        type: "BILL_UPDATED",
        entityId: billId,
        entityCode: existing.code,
        description: `Bill ${existing.code} updated - Rs.${totals.grandTotal}`,
      });

      await conn.commit();
      return res.json({ ok: true, message: "Bill updated successfully" });
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
  requirePermission("can_delete_bills"),
  [param("id").isInt().toInt()],
  async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      await ensureBillSchemaCompatibility(conn);
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
          userId: req.user.id,
          productId: item.product_id,
          adjustment: -Number(item.quantity),
          type: "PURCHASE_RETURN",
          reason: `Bill deleted - ${bill.code}`,
          refId: bill.id,
          refCode: bill.code,
          inventoryCode: stockCode,
        });
      }

      const oldEffect = round2(Number(bill.paid_amount) - Number(bill.grand_total));
      await conn.execute(
        "UPDATE vendors SET balance = balance - ? WHERE id = ? AND user_id = ?",
        [oldEffect, bill.vendor_id, req.user.id]
      );

      await conn.execute("DELETE FROM bills WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);

      await logActivity(conn, {
        userId: req.user.id,
        type: "BILL_DELETED",
        entityId: bill.id,
        entityCode: bill.code,
        description: `Bill ${bill.code} deleted - stock reversed`,
      });

      await conn.commit();
      return res.json({ ok: true, message: "Bill deleted and stock reversed" });
    } catch (error) {
      await conn.rollback();
      next(error);
    } finally {
      conn.release();
    }
  }
);

module.exports = router;
