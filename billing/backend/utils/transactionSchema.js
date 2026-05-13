let ensureInvoiceSchemaPromise = null;
let ensureBillSchemaPromise = null;

async function getExistingColumns(conn, tableName, columnNames) {
  const placeholders = columnNames.map(() => "?").join(", ");
  const [rows] = await conn.execute(
    `SELECT COLUMN_NAME
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND column_name IN (${placeholders})`,
    [tableName, ...columnNames]
  );

  return new Set(rows.map((row) => String(row.COLUMN_NAME || "").toLowerCase()));
}

async function ensureInvoiceSchemaCompatibility(conn) {
  if (ensureInvoiceSchemaPromise) {
    return ensureInvoiceSchemaPromise;
  }

  ensureInvoiceSchemaPromise = (async () => {
    const invoiceColumns = [
      "customer_salutation",
      "customer_name",
      "customer_mobile",
      "customer_email",
      "customer_gstin",
      "customer_billing_address",
      "customer_shipping_address",
      "customer_country",
      "customer_state_name",
      "customer_state_code",
      "place_of_supply_state_name",
      "place_of_supply_state_code",
      "place_of_supply_country",
      "company_state_name",
      "company_state_code",
      "supply_type",
      "is_export",
      "price_includes_gst",
      "taxable_total",
      "total_cgst",
      "total_sgst",
      "total_igst",
      "previous_balance",
      "discount_type",
      "discount_input",
    ];
    const invoiceItemColumns = [
      "hsn_sac_code",
      "base_value",
      "discount_value",
      "taxable_value",
      "cgst_rate",
      "cgst_amount",
      "sgst_rate",
      "sgst_amount",
      "igst_rate",
      "igst_amount",
    ];

    const existingInvoices = await getExistingColumns(conn, "invoices", invoiceColumns);
    const existingInvoiceItems = await getExistingColumns(conn, "invoice_items", invoiceItemColumns);

    if (!existingInvoices.has("customer_salutation")) await conn.execute("ALTER TABLE invoices ADD COLUMN customer_salutation VARCHAR(10) NULL AFTER customer_id");
    if (!existingInvoices.has("customer_name")) await conn.execute("ALTER TABLE invoices ADD COLUMN customer_name VARCHAR(200) NULL AFTER customer_salutation");
    if (!existingInvoices.has("customer_mobile")) await conn.execute("ALTER TABLE invoices ADD COLUMN customer_mobile VARCHAR(20) NULL AFTER customer_name");
    if (!existingInvoices.has("customer_email")) await conn.execute("ALTER TABLE invoices ADD COLUMN customer_email VARCHAR(180) NULL AFTER customer_mobile");
    if (!existingInvoices.has("customer_gstin")) await conn.execute("ALTER TABLE invoices ADD COLUMN customer_gstin VARCHAR(20) NULL AFTER customer_email");
    if (!existingInvoices.has("customer_billing_address")) await conn.execute("ALTER TABLE invoices ADD COLUMN customer_billing_address TEXT NULL AFTER customer_gstin");
    if (!existingInvoices.has("customer_shipping_address")) await conn.execute("ALTER TABLE invoices ADD COLUMN customer_shipping_address TEXT NULL AFTER customer_billing_address");
    if (!existingInvoices.has("customer_country")) await conn.execute("ALTER TABLE invoices ADD COLUMN customer_country VARCHAR(120) NOT NULL DEFAULT 'India' AFTER customer_shipping_address");
    if (!existingInvoices.has("customer_state_name")) await conn.execute("ALTER TABLE invoices ADD COLUMN customer_state_name VARCHAR(120) NULL AFTER customer_country");
    if (!existingInvoices.has("customer_state_code")) await conn.execute("ALTER TABLE invoices ADD COLUMN customer_state_code VARCHAR(2) NULL AFTER customer_state_name");
    if (!existingInvoices.has("place_of_supply_state_name")) await conn.execute("ALTER TABLE invoices ADD COLUMN place_of_supply_state_name VARCHAR(120) NULL AFTER customer_state_code");
    if (!existingInvoices.has("place_of_supply_state_code")) await conn.execute("ALTER TABLE invoices ADD COLUMN place_of_supply_state_code VARCHAR(2) NULL AFTER place_of_supply_state_name");
    if (!existingInvoices.has("place_of_supply_country")) await conn.execute("ALTER TABLE invoices ADD COLUMN place_of_supply_country VARCHAR(120) NULL AFTER place_of_supply_state_code");
    if (!existingInvoices.has("company_state_name")) await conn.execute("ALTER TABLE invoices ADD COLUMN company_state_name VARCHAR(120) NULL AFTER place_of_supply_country");
    if (!existingInvoices.has("company_state_code")) await conn.execute("ALTER TABLE invoices ADD COLUMN company_state_code VARCHAR(2) NULL AFTER company_state_name");
    if (!existingInvoices.has("supply_type")) await conn.execute("ALTER TABLE invoices ADD COLUMN supply_type ENUM('INTRA_STATE','INTER_STATE','EXPORT') NOT NULL DEFAULT 'INTRA_STATE' AFTER company_state_code");
    if (!existingInvoices.has("is_export")) await conn.execute("ALTER TABLE invoices ADD COLUMN is_export TINYINT(1) NOT NULL DEFAULT 0 AFTER supply_type");
    if (!existingInvoices.has("price_includes_gst")) await conn.execute("ALTER TABLE invoices ADD COLUMN price_includes_gst TINYINT(1) NOT NULL DEFAULT 0 AFTER is_export");
    if (!existingInvoices.has("taxable_total")) await conn.execute("ALTER TABLE invoices ADD COLUMN taxable_total DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER discount");
    if (!existingInvoices.has("total_cgst")) await conn.execute("ALTER TABLE invoices ADD COLUMN total_cgst DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER taxable_total");
    if (!existingInvoices.has("total_sgst")) await conn.execute("ALTER TABLE invoices ADD COLUMN total_sgst DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER total_cgst");
    if (!existingInvoices.has("total_igst")) await conn.execute("ALTER TABLE invoices ADD COLUMN total_igst DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER total_sgst");
    if (!existingInvoices.has("previous_balance")) await conn.execute("ALTER TABLE invoices ADD COLUMN previous_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER paid_amount");
    if (!existingInvoices.has("discount_type")) await conn.execute("ALTER TABLE invoices ADD COLUMN discount_type ENUM('PERCENTAGE','AMOUNT') NOT NULL DEFAULT 'PERCENTAGE' AFTER discount");
    if (!existingInvoices.has("discount_input")) await conn.execute("ALTER TABLE invoices ADD COLUMN discount_input DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER discount_type");

    if (!existingInvoiceItems.has("hsn_sac_code")) await conn.execute('ALTER TABLE invoice_items ADD COLUMN hsn_sac_code VARCHAR(20) NOT NULL DEFAULT "" AFTER product_id');
    if (!existingInvoiceItems.has("base_value")) await conn.execute("ALTER TABLE invoice_items ADD COLUMN base_value DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER quantity");
    if (!existingInvoiceItems.has("discount_value")) await conn.execute("ALTER TABLE invoice_items ADD COLUMN discount_value DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER base_value");
    if (!existingInvoiceItems.has("taxable_value")) await conn.execute("ALTER TABLE invoice_items ADD COLUMN taxable_value DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER discount_value");
    if (!existingInvoiceItems.has("cgst_rate")) await conn.execute("ALTER TABLE invoice_items ADD COLUMN cgst_rate DECIMAL(6,3) NOT NULL DEFAULT 0.000 AFTER tax_rate");
    if (!existingInvoiceItems.has("cgst_amount")) await conn.execute("ALTER TABLE invoice_items ADD COLUMN cgst_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER cgst_rate");
    if (!existingInvoiceItems.has("sgst_rate")) await conn.execute("ALTER TABLE invoice_items ADD COLUMN sgst_rate DECIMAL(6,3) NOT NULL DEFAULT 0.000 AFTER cgst_amount");
    if (!existingInvoiceItems.has("sgst_amount")) await conn.execute("ALTER TABLE invoice_items ADD COLUMN sgst_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER sgst_rate");
    if (!existingInvoiceItems.has("igst_rate")) await conn.execute("ALTER TABLE invoice_items ADD COLUMN igst_rate DECIMAL(6,3) NOT NULL DEFAULT 0.000 AFTER sgst_amount");
    if (!existingInvoiceItems.has("igst_amount")) await conn.execute("ALTER TABLE invoice_items ADD COLUMN igst_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER igst_rate");
  })();

  try {
    await ensureInvoiceSchemaPromise;
  } catch (error) {
    ensureInvoiceSchemaPromise = null;
    throw error;
  }
}

async function ensureBillSchemaCompatibility(conn) {
  if (ensureBillSchemaPromise) {
    return ensureBillSchemaPromise;
  }

  ensureBillSchemaPromise = (async () => {
    const billColumns = [
      "vendor_salutation",
      "vendor_name",
      "vendor_mobile",
      "vendor_email",
      "vendor_gstin",
      "vendor_billing_address",
      "vendor_shipping_address",
      "vendor_country",
      "vendor_state_name",
      "vendor_state_code",
      "place_of_supply_state_name",
      "place_of_supply_state_code",
      "place_of_supply_country",
      "company_state_name",
      "company_state_code",
      "supply_type",
      "is_import",
      "price_includes_gst",
      "taxable_total",
      "total_cgst",
      "total_sgst",
      "total_igst",
      "previous_balance",
      "discount_type",
      "discount_input",
    ];
    const billItemColumns = [
      "hsn_sac_code",
      "base_value",
      "discount_value",
      "taxable_value",
      "cgst_rate",
      "cgst_amount",
      "sgst_rate",
      "sgst_amount",
      "igst_rate",
      "igst_amount",
    ];

    const existingBills = await getExistingColumns(conn, "bills", billColumns);
    const existingBillItems = await getExistingColumns(conn, "bill_items", billItemColumns);

    if (!existingBills.has("vendor_salutation")) await conn.execute("ALTER TABLE bills ADD COLUMN vendor_salutation VARCHAR(10) NULL AFTER vendor_id");
    if (!existingBills.has("vendor_name")) await conn.execute("ALTER TABLE bills ADD COLUMN vendor_name VARCHAR(200) NULL AFTER vendor_salutation");
    if (!existingBills.has("vendor_mobile")) await conn.execute("ALTER TABLE bills ADD COLUMN vendor_mobile VARCHAR(20) NULL AFTER vendor_name");
    if (!existingBills.has("vendor_email")) await conn.execute("ALTER TABLE bills ADD COLUMN vendor_email VARCHAR(180) NULL AFTER vendor_mobile");
    if (!existingBills.has("vendor_gstin")) await conn.execute("ALTER TABLE bills ADD COLUMN vendor_gstin VARCHAR(20) NULL AFTER vendor_email");
    if (!existingBills.has("vendor_billing_address")) await conn.execute("ALTER TABLE bills ADD COLUMN vendor_billing_address TEXT NULL AFTER vendor_gstin");
    if (!existingBills.has("vendor_shipping_address")) await conn.execute("ALTER TABLE bills ADD COLUMN vendor_shipping_address TEXT NULL AFTER vendor_billing_address");
    if (!existingBills.has("vendor_country")) await conn.execute("ALTER TABLE bills ADD COLUMN vendor_country VARCHAR(120) NOT NULL DEFAULT 'India' AFTER vendor_shipping_address");
    if (!existingBills.has("vendor_state_name")) await conn.execute("ALTER TABLE bills ADD COLUMN vendor_state_name VARCHAR(120) NULL AFTER vendor_country");
    if (!existingBills.has("vendor_state_code")) await conn.execute("ALTER TABLE bills ADD COLUMN vendor_state_code VARCHAR(2) NULL AFTER vendor_state_name");
    if (!existingBills.has("place_of_supply_state_name")) await conn.execute("ALTER TABLE bills ADD COLUMN place_of_supply_state_name VARCHAR(120) NULL AFTER vendor_state_code");
    if (!existingBills.has("place_of_supply_state_code")) await conn.execute("ALTER TABLE bills ADD COLUMN place_of_supply_state_code VARCHAR(2) NULL AFTER place_of_supply_state_name");
    if (!existingBills.has("place_of_supply_country")) await conn.execute("ALTER TABLE bills ADD COLUMN place_of_supply_country VARCHAR(120) NULL AFTER place_of_supply_state_code");
    if (!existingBills.has("company_state_name")) await conn.execute("ALTER TABLE bills ADD COLUMN company_state_name VARCHAR(120) NULL AFTER place_of_supply_country");
    if (!existingBills.has("company_state_code")) await conn.execute("ALTER TABLE bills ADD COLUMN company_state_code VARCHAR(2) NULL AFTER company_state_name");
    if (!existingBills.has("supply_type")) await conn.execute("ALTER TABLE bills ADD COLUMN supply_type ENUM('INTRA_STATE','INTER_STATE','IMPORT') NOT NULL DEFAULT 'INTRA_STATE' AFTER company_state_code");
    if (!existingBills.has("is_import")) await conn.execute("ALTER TABLE bills ADD COLUMN is_import TINYINT(1) NOT NULL DEFAULT 0 AFTER supply_type");
    if (!existingBills.has("price_includes_gst")) await conn.execute("ALTER TABLE bills ADD COLUMN price_includes_gst TINYINT(1) NOT NULL DEFAULT 0 AFTER is_import");
    if (!existingBills.has("taxable_total")) await conn.execute("ALTER TABLE bills ADD COLUMN taxable_total DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER discount");
    if (!existingBills.has("total_cgst")) await conn.execute("ALTER TABLE bills ADD COLUMN total_cgst DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER taxable_total");
    if (!existingBills.has("total_sgst")) await conn.execute("ALTER TABLE bills ADD COLUMN total_sgst DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER total_cgst");
    if (!existingBills.has("total_igst")) await conn.execute("ALTER TABLE bills ADD COLUMN total_igst DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER total_sgst");
    if (!existingBills.has("previous_balance")) await conn.execute("ALTER TABLE bills ADD COLUMN previous_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER paid_amount");
    if (!existingBills.has("discount_type")) await conn.execute("ALTER TABLE bills ADD COLUMN discount_type ENUM('PERCENTAGE','AMOUNT') NOT NULL DEFAULT 'PERCENTAGE' AFTER discount");
    if (!existingBills.has("discount_input")) await conn.execute("ALTER TABLE bills ADD COLUMN discount_input DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER discount_type");

    if (!existingBillItems.has("hsn_sac_code")) await conn.execute('ALTER TABLE bill_items ADD COLUMN hsn_sac_code VARCHAR(20) NOT NULL DEFAULT "" AFTER product_id');
    if (!existingBillItems.has("base_value")) await conn.execute("ALTER TABLE bill_items ADD COLUMN base_value DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER quantity");
    if (!existingBillItems.has("discount_value")) await conn.execute("ALTER TABLE bill_items ADD COLUMN discount_value DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER base_value");
    if (!existingBillItems.has("taxable_value")) await conn.execute("ALTER TABLE bill_items ADD COLUMN taxable_value DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER discount_value");
    if (!existingBillItems.has("cgst_rate")) await conn.execute("ALTER TABLE bill_items ADD COLUMN cgst_rate DECIMAL(6,3) NOT NULL DEFAULT 0.000 AFTER tax_rate");
    if (!existingBillItems.has("cgst_amount")) await conn.execute("ALTER TABLE bill_items ADD COLUMN cgst_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER cgst_rate");
    if (!existingBillItems.has("sgst_rate")) await conn.execute("ALTER TABLE bill_items ADD COLUMN sgst_rate DECIMAL(6,3) NOT NULL DEFAULT 0.000 AFTER cgst_amount");
    if (!existingBillItems.has("sgst_amount")) await conn.execute("ALTER TABLE bill_items ADD COLUMN sgst_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER sgst_rate");
    if (!existingBillItems.has("igst_rate")) await conn.execute("ALTER TABLE bill_items ADD COLUMN igst_rate DECIMAL(6,3) NOT NULL DEFAULT 0.000 AFTER sgst_amount");
    if (!existingBillItems.has("igst_amount")) await conn.execute("ALTER TABLE bill_items ADD COLUMN igst_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER igst_rate");
  })();

  try {
    await ensureBillSchemaPromise;
  } catch (error) {
    ensureBillSchemaPromise = null;
    throw error;
  }
}

module.exports = {
  ensureBillSchemaCompatibility,
  ensureInvoiceSchemaCompatibility,
};
