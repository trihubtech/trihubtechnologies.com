const { numberToWords, round2 } = require("./helpers");
const { loadCompanyProfile } = require("./tenancy");
const { INDIA_TIME_ZONE } = require("./time");

function cleanText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { timeZone: INDIA_TIME_ZONE });
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.toLocaleDateString("en-GB", { timeZone: INDIA_TIME_ZONE })} ${date.toLocaleTimeString("en-IN", {
    timeZone: INDIA_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function formatMoney(value) {
  return round2(Number(value || 0));
}

function joinAddress(...parts) {
  return parts
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join(", ");
}

function buildPartyBlock({
  name,
  salutation,
  address,
  stateName,
  stateCode,
  gstin,
  country,
  mobile,
  email,
}) {
  const resolvedName = [cleanText(salutation), cleanText(name)].filter(Boolean).join(" ");

  return {
    name: resolvedName || cleanText(name),
    address: cleanText(address),
    state_name: cleanText(stateName),
    state_code: cleanText(stateCode),
    gstin: cleanText(gstin),
    country: cleanText(country) || "India",
    mobile: cleanText(mobile),
    email: cleanText(email),
  };
}

function deriveSupplyLabel(invoice) {
  if (invoice.supply_type === "EXPORT") {
    return "EXPORT";
  }
  if (invoice.supply_type === "INTRA_STATE") {
    return "INTRASTATE";
  }
  if (invoice.supply_type === "INTER_STATE") {
    return "INTERSTATE";
  }
  return cleanText(invoice.supply_type);
}

function buildInvoiceNotes(invoice) {
  const notes = [];
  if (cleanText(invoice.notes)) {
    notes.push(cleanText(invoice.notes));
  }
  if (invoice.is_export) {
    notes.push("Supply Meant for Export under LUT / Bond - Zero Rated Supply");
  }
  return notes;
}

function buildTerms(companyName, customTerms) {
  if (customTerms && typeof customTerms === "string" && customTerms.trim()) {
    const lines = customTerms.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length) return lines;
  }
  return [
    "Certified that the particulars given above are true and correct and the amount indicated represents the price actually charged.",
    "Goods once sold will not be taken back or exchanged.",
    "Interest may be charged on overdue invoices as per agreed terms.",
    "Subject to seller jurisdiction only.",
  ];
}

function buildExcelSafeText(value) {
  return cleanText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadInvoiceDocument(executor, userId, companyId, invoiceId) {
  const [[invoice]] = await executor.execute(
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
       COALESCE(i.customer_country, c.country, 'India') AS customer_country
     FROM invoices i
     LEFT JOIN customers c
       ON c.id = i.customer_id AND c.user_id = i.user_id
     WHERE i.id = ? AND i.user_id = ?`,
    [invoiceId, userId]
  );

  if (!invoice) {
    return null;
  }

  const [items] = await executor.execute(
    `SELECT
       ii.*,
       p.code AS product_code,
       p.name AS product_name,
       p.unit AS product_unit,
       p.category AS product_category,
       COALESCE(ii.hsn_sac_code, p.hsn_sac_code, '') AS line_hsn_sac_code
     FROM invoice_items ii
     LEFT JOIN products p
       ON p.id = ii.product_id AND p.user_id = ii.user_id
     WHERE ii.invoice_id = ? AND ii.user_id = ?
     ORDER BY ii.id ASC`,
    [invoiceId, userId]
  );

  const company = await loadCompanyProfile(executor, companyId);

  // If item-level discounts are missing but the invoice has a discount, allocate it dynamically for the report
  const totalItemDiscount = (items || []).reduce((sum, item) => sum + Number(item.discount_value || 0), 0);
  let allocatedDiscounts = [];
  if (totalItemDiscount <= 0 && Number(invoice.discount) > 0) {
    const { allocateDiscounts } = require("./gst");
    const baseValues = (items || []).map((item) => Number(item.base_value || 0));
    allocatedDiscounts = allocateDiscounts(baseValues, Number(invoice.discount));
  }

  const normalizedItems = (items || []).map((item, index) => {
    const discountValue = allocatedDiscounts.length > 0 
      ? allocatedDiscounts[index] 
      : Number(item.discount_value || 0);
    
    // Recalculate taxable value if we just allocated a discount
    const taxableValue = allocatedDiscounts.length > 0
      ? Number(item.base_value || 0) - discountValue
      : (item.taxable_value || item.value || item.base_value);

    return {
      sr_no: index + 1,
      description: cleanText(item.product_name || item.product_code || `Item ${index + 1}`),
      hsn_sac_code: cleanText(item.hsn_sac_code || item.line_hsn_sac_code),
      quantity: formatMoney(item.quantity),
      unit: cleanText(item.product_unit) || "NOS",
      rate: formatMoney(item.rate),
      gross_total: formatMoney(item.base_value),
      discount_value: formatMoney(discountValue),
      taxable_value: formatMoney(taxableValue),
      cgst_rate: formatMoney(item.cgst_rate),
      cgst_amount: formatMoney(item.cgst_amount),
      sgst_rate: formatMoney(item.sgst_rate),
      sgst_amount: formatMoney(item.sgst_amount),
      igst_rate: formatMoney(item.igst_rate),
      igst_amount: formatMoney(item.igst_amount),
      total_amount: formatMoney(item.total_value),
    };
  });

  const billing = buildPartyBlock({
    name: invoice.customer_name,
    salutation: invoice.customer_salutation,
    address: invoice.customer_billing_address,
    stateName: invoice.customer_state_name,
    stateCode: invoice.customer_state_code,
    gstin: invoice.customer_gstin,
    country: invoice.customer_country,
    mobile: invoice.customer_mobile,
    email: invoice.customer_email,
  });

  const shipping = buildPartyBlock({
    name: invoice.customer_name,
    address: invoice.customer_shipping_address || invoice.customer_billing_address,
    stateName: invoice.place_of_supply_state_name || invoice.customer_state_name,
    stateCode: invoice.place_of_supply_state_code || invoice.customer_state_code,
    gstin: invoice.customer_gstin,
    country: invoice.place_of_supply_country || invoice.customer_country,
    mobile: invoice.customer_mobile,
    email: invoice.customer_email,
  });

  const supplyLabel = deriveSupplyLabel(invoice);
  const placeOfSupply = invoice.place_of_supply_state_name
    ? `${cleanText(invoice.place_of_supply_state_name)}${cleanText(invoice.place_of_supply_state_code) ? ` (${cleanText(invoice.place_of_supply_state_code)})` : ""}`
    : cleanText(invoice.place_of_supply_country);

  return {
    invoice: {
      id: invoice.id,
      code: cleanText(invoice.code || invoice.number),
      number: cleanText(invoice.number || invoice.code),
      date: invoice.date,
      formatted_date: formatDate(invoice.date),
      formatted_date_time: formatDateTime(invoice.date),
      term: cleanText(invoice.term),
      status: cleanText(invoice.status),
      place_of_supply: placeOfSupply,
      place_of_supply_state_name: cleanText(invoice.place_of_supply_state_name),
      place_of_supply_state_code: cleanText(invoice.place_of_supply_state_code),
      place_of_supply_country: cleanText(invoice.place_of_supply_country),
      supply_type: cleanText(invoice.supply_type),
      supply_label: supplyLabel,
      sub_total: formatMoney(invoice.sub_total),
      discount: formatMoney(invoice.discount),
      taxable_total: formatMoney(invoice.taxable_total),
      total_cgst: formatMoney(invoice.total_cgst),
      total_sgst: formatMoney(invoice.total_sgst),
      total_igst: formatMoney(invoice.total_igst),
      total_tax: formatMoney(invoice.total_tax),
      grand_total: formatMoney(invoice.grand_total),
      amount_in_words: cleanText(invoice.amount_in_words) || numberToWords(Number(invoice.grand_total || 0)),
      notes: buildInvoiceNotes(invoice),
      loading_charges: 0,
      transport_charges: 0,
      vehicle_no: "",
      mode_of_transport: "",
      reference_number: cleanText(invoice.code || invoice.number),
    },
    company: {
      name: cleanText(company?.name) || "Company Name",
      address: cleanText(company?.address),
      gstin: cleanText(company?.gstin),
      phone: cleanText(company?.phone),
      email: cleanText(company?.email),
      website: cleanText(company?.website),
      country: cleanText(company?.country) || "India",
      state_name: cleanText(company?.state_name),
      state_code: cleanText(company?.state_code),
      pan: cleanText(company?.pan),
      logo: cleanText(company?.logo),
      authorized_signature: cleanText(company?.authorized_signature),
      bank_name: cleanText(company?.bank_name),
      bank_account_number: cleanText(company?.bank_account_number),
      bank_ifsc: cleanText(company?.bank_ifsc),
      bank_branch: cleanText(company?.bank_branch),
      upi_id: cleanText(company?.upi_id),
      upi_name: cleanText(company?.upi_name),
      terms_and_conditions: company?.terms_and_conditions || "",
    },
    billing,
    shipping,
    items: normalizedItems,
    summary: {
      gross_total: formatMoney(invoice.sub_total),
      discount: formatMoney(invoice.discount),
      taxable_total: formatMoney(invoice.taxable_total),
      total_cgst: formatMoney(invoice.total_cgst),
      total_sgst: formatMoney(invoice.total_sgst),
      total_igst: formatMoney(invoice.total_igst),
      total_tax: formatMoney(invoice.total_tax),
      total_amount: formatMoney(invoice.grand_total),
    },
    terms: buildTerms(cleanText(company?.name), company?.terms_and_conditions),
  };
}

function buildSpreadsheetRow(cells, { height = 22 } = {}) {
  return `<Row ss:Height="${height}">${cells.join("")}</Row>`;
}

function cell(value, { styleId = "s_data", type = "String", mergeAcross = null } = {}) {
  const mergeAttr = mergeAcross != null ? ` ss:MergeAcross="${mergeAcross}"` : "";
  const payload = value == null || value === ""
    ? ""
    : `<Data ss:Type="${type}">${type === "String" ? buildExcelSafeText(value) : value}</Data>`;
  return `<Cell${mergeAttr} ss:StyleID="${styleId}">${payload}</Cell>`;
}

function moneyCell(value, { styleId = "s_num" } = {}) {
  return cell(formatMoney(value), { styleId, type: "Number" });
}

function buildGstInvoiceSpreadsheet(document) {
  const companyLine = joinAddress(
    document.company.address,
    document.company.state_name,
    document.company.state_code ? `State Code: ${document.company.state_code}` : "",
    document.company.country
  );
  const customerShipAddress = cleanText(document.shipping.address) || cleanText(document.billing.address);
  const bankSummary = [
    document.company.bank_name ? `Bank Name: ${document.company.bank_name}` : "",
    document.company.bank_account_number ? `Account No: ${document.company.bank_account_number}` : "",
    document.company.bank_ifsc ? `IFSC Code: ${document.company.bank_ifsc}` : "",
    document.company.bank_branch ? `Branch: ${document.company.bank_branch}` : "",
    document.company.upi_id ? `UPI: ${document.company.upi_id}` : "",
  ].filter(Boolean);

  const rows = [
    buildSpreadsheetRow([cell("TAX INVOICE", { styleId: "s_title", mergeAcross: 14 })], { height: 44 }),
    buildSpreadsheetRow([cell("", { styleId: "s_spacer", mergeAcross: 14 })], { height: 8 }),
    buildSpreadsheetRow([
      cell("SUPPLIER DETAILS", { styleId: "s_sechead", mergeAcross: 7 }),
      cell("INVOICE DETAILS", { styleId: "s_sechead", mergeAcross: 6 }),
    ]),
    buildSpreadsheetRow([
      cell(`Business Name: ${document.company.name}`, { styleId: "s_data", mergeAcross: 7 }),
      cell(`Invoice No: ${document.invoice.number || document.invoice.code}`, { styleId: "s_data", mergeAcross: 6 }),
    ]),
    buildSpreadsheetRow([
      cell(`Address: ${companyLine || "-"}`, { styleId: "s_data", mergeAcross: 7 }),
      cell(`Invoice Date: ${document.invoice.formatted_date}`, { styleId: "s_data", mergeAcross: 6 }),
    ]),
    buildSpreadsheetRow([
      cell(`GSTIN: ${document.company.gstin || "-"}`, { styleId: "s_data", mergeAcross: 7 }),
      cell(`Date & Time of Supply: ${document.invoice.formatted_date_time}`, { styleId: "s_data", mergeAcross: 6 }),
    ]),
    buildSpreadsheetRow([
      cell(`State: ${document.company.state_name || "-"}  |  State Code: ${document.company.state_code || "-"}`, { styleId: "s_data", mergeAcross: 7 }),
      cell(`Mode of Transport: ${document.invoice.mode_of_transport || "-"}`, { styleId: "s_data", mergeAcross: 6 }),
    ]),
    buildSpreadsheetRow([
      cell(`Email: ${document.company.email || "-"}  |  Phone: ${document.company.phone || "-"}`, { styleId: "s_data", mergeAcross: 7 }),
      cell(`Vehicle No: ${document.invoice.vehicle_no || "-"}  |  Place of Supply: ${document.invoice.place_of_supply || "-"}`, { styleId: "s_data", mergeAcross: 6 }),
    ]),
    buildSpreadsheetRow([cell("", { styleId: "s_spacer", mergeAcross: 14 })], { height: 8 }),
    buildSpreadsheetRow([
      cell("BILL TO (CUSTOMER DETAILS)", { styleId: "s_sechead", mergeAcross: 7 }),
      cell("SHIP TO (IF DIFFERENT FROM BILLING ADDRESS)", { styleId: "s_sechead", mergeAcross: 6 }),
    ]),
    buildSpreadsheetRow([
      cell(`Name: ${document.billing.name || "-"}`, { styleId: "s_data", mergeAcross: 7 }),
      cell(`Name: ${document.shipping.name || document.billing.name || "-"}`, { styleId: "s_data", mergeAcross: 6 }),
    ]),
    buildSpreadsheetRow([
      cell(`Address: ${document.billing.address || "-"}`, { styleId: "s_data", mergeAcross: 7 }),
      cell(`Address: ${customerShipAddress || "-"}`, { styleId: "s_data", mergeAcross: 6 }),
    ]),
    buildSpreadsheetRow([
      cell(`GSTIN: ${document.billing.gstin || "-"}`, { styleId: "s_data", mergeAcross: 7 }),
      cell(`State: ${document.shipping.state_name || "-"}  |  State Code: ${document.shipping.state_code || "-"}`, { styleId: "s_data", mergeAcross: 6 }),
    ]),
    buildSpreadsheetRow([
      cell(`State: ${document.billing.state_name || "-"}  |  State Code: ${document.billing.state_code || "-"}`, { styleId: "s_data", mergeAcross: 7 }),
      cell(`Phone: ${document.shipping.mobile || document.billing.mobile || "-"}`, { styleId: "s_data", mergeAcross: 6 }),
    ]),
    buildSpreadsheetRow([cell("", { styleId: "s_spacer", mergeAcross: 14 })], { height: 8 }),
    buildSpreadsheetRow([
      cell(`Place of Supply: ${document.invoice.place_of_supply || "-"}  |  Supply Type: ${document.invoice.supply_label || "-"}`, { styleId: "s_infobox", mergeAcross: 7 }),
      cell("GST split is line-wise and follows the saved invoice tax breakup.", { styleId: "s_infobox", mergeAcross: 6 }),
    ], { height: 24 }),
    buildSpreadsheetRow([cell("", { styleId: "s_spacer", mergeAcross: 14 })], { height: 8 }),
    buildSpreadsheetRow([
      cell("Sr.", { styleId: "s_colhead" }),
      cell("Description of Goods / Services", { styleId: "s_colhead" }),
      cell("HSN / SAC Code", { styleId: "s_colhead" }),
      cell("Qty", { styleId: "s_colhead" }),
      cell("Unit (UQC)", { styleId: "s_colhead" }),
      cell("Rate per Unit (Rs.)", { styleId: "s_colhead" }),
      cell("Discount (Rs.)", { styleId: "s_colhead" }),
      cell("Taxable Value (Rs.)", { styleId: "s_colhead" }),
      cell("CGST %", { styleId: "s_colhead" }),
      cell("CGST Amount (Rs.)", { styleId: "s_colhead" }),
      cell("SGST / UTGST %", { styleId: "s_colhead" }),
      cell("SGST / UTGST Amount (Rs.)", { styleId: "s_colhead" }),
      cell("IGST %", { styleId: "s_colhead" }),
      cell("IGST Amount (Rs.)", { styleId: "s_colhead" }),
      cell("Total Amount (Rs.)", { styleId: "s_colhead" }),
    ], { height: 38 }),
  ];

  document.items.forEach((item, index) => {
    const alt = index % 2 === 1;
    rows.push(
      buildSpreadsheetRow([
        cell(item.sr_no, { styleId: alt ? "s_center_alt" : "s_center", type: "Number" }),
        cell(item.description, { styleId: alt ? "s_item_alt" : "s_item" }),
        cell(item.hsn_sac_code || "", { styleId: alt ? "s_center_alt" : "s_center" }),
        cell(item.quantity, { styleId: alt ? "s_center_alt" : "s_center", type: "Number" }),
        cell(item.unit, { styleId: alt ? "s_center_alt" : "s_center" }),
        moneyCell(item.rate, { styleId: alt ? "s_num_alt" : "s_num" }),
        moneyCell(item.discount_value, { styleId: alt ? "s_num_alt" : "s_num" }),
        moneyCell(item.taxable_value, { styleId: alt ? "s_num_alt" : "s_num" }),
        cell(item.cgst_rate ? item.cgst_rate.toFixed(2) : "", { styleId: alt ? "s_center_alt" : "s_center" }),
        moneyCell(item.cgst_amount, { styleId: alt ? "s_num_alt" : "s_num" }),
        cell(item.sgst_rate ? item.sgst_rate.toFixed(2) : "", { styleId: alt ? "s_center_alt" : "s_center" }),
        moneyCell(item.sgst_amount, { styleId: alt ? "s_num_alt" : "s_num" }),
        cell(item.igst_rate ? item.igst_rate.toFixed(2) : "", { styleId: alt ? "s_center_alt" : "s_center" }),
        moneyCell(item.igst_amount, { styleId: alt ? "s_num_alt" : "s_num" }),
        moneyCell(item.total_amount, { styleId: alt ? "s_num_alt" : "s_num" }),
      ], { height: 28 })
    );
  });

  rows.push(
    buildSpreadsheetRow([
      cell("SUB-TOTAL (TAXABLE VALUE)", { styleId: "s_subtotal_lbl", mergeAcross: 5 }),
      cell("", { styleId: "s_subtotal_lbl" }),
      moneyCell(document.summary.taxable_total, { styleId: "s_subtotal" }),
      cell("", { styleId: "s_subtotal_lbl" }),
      moneyCell(document.summary.total_cgst, { styleId: "s_subtotal" }),
      cell("", { styleId: "s_subtotal_lbl" }),
      moneyCell(document.summary.total_sgst, { styleId: "s_subtotal" }),
      cell("", { styleId: "s_subtotal_lbl" }),
      moneyCell(document.summary.total_igst, { styleId: "s_subtotal" }),
      moneyCell(document.summary.total_amount, { styleId: "s_subtotal" }),
    ], { height: 30 }),
    buildSpreadsheetRow([
      cell("GRAND TOTAL (Rs.)", { styleId: "s_grandtotal_lbl", mergeAcross: 13 }),
      moneyCell(document.summary.total_amount, { styleId: "s_grandtotal" }),
    ], { height: 34 }),
    buildSpreadsheetRow([cell("", { styleId: "s_spacer", mergeAcross: 14 })], { height: 8 }),
    buildSpreadsheetRow([
      cell(`Amount in Words: ${document.invoice.amount_in_words}`, { styleId: "s_data", mergeAcross: 14 }),
    ], { height: 24 }),
    buildSpreadsheetRow([cell("", { styleId: "s_spacer", mergeAcross: 14 })], { height: 8 }),
    buildSpreadsheetRow([
      cell("BANK DETAILS FOR PAYMENT", { styleId: "s_sechead", mergeAcross: 14 }),
    ]),
    buildSpreadsheetRow([
      cell(bankSummary[0] || "Bank Name: -", { styleId: "s_bank", mergeAcross: 3 }),
      cell(bankSummary[1] || "Account No: -", { styleId: "s_bank", mergeAcross: 3 }),
      cell(bankSummary[2] || "IFSC Code: -", { styleId: "s_bank", mergeAcross: 3 }),
      cell(bankSummary[3] || bankSummary[4] || "Branch / UPI: -", { styleId: "s_bank", mergeAcross: 3 }),
    ]),
    buildSpreadsheetRow([cell("", { styleId: "s_spacer", mergeAcross: 14 })], { height: 8 }),
    buildSpreadsheetRow([
      cell("TERMS & CONDITIONS", { styleId: "s_sechead", mergeAcross: 9 }),
      cell(`FOR ${document.company.name.toUpperCase()}`, { styleId: "s_sechead", mergeAcross: 4 }),
    ]),
  );

  const termsToRender = document.terms.length ? document.terms : [""];
  const signMergeDown = Math.max(termsToRender.length - 1, 0);
  termsToRender.forEach((term, idx) => {
    const cells = [cell(term || "", { styleId: "s_terms", mergeAcross: 9 })];
    if (idx === 0) {
      cells.push(`<Cell ss:MergeAcross="4" ss:MergeDown="${signMergeDown}" ss:StyleID="s_sign"><Data ss:Type="String">Authorized Signatory</Data></Cell>`);
    }
    rows.push(buildSpreadsheetRow(cells));
  });

  rows.push(
    buildSpreadsheetRow([cell("", { styleId: "s_spacer", mergeAcross: 14 })], { height: 8 }),
    buildSpreadsheetRow([
      cell(`Generated from CRM for ${document.company.name}.`, { styleId: "s_footer", mergeAcross: 14 }),
    ], { height: 18 })
  );

  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:html="http://www.w3.org/TR/REC-html40"><Styles><Style ss:ID="s_title"><Font ss:Bold="1" ss:Size="22" ss:Color="#FFFFFF" ss:FontName="Calibri"/><Interior ss:Color="#0a58ca" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#084db0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#084db0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#084db0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#084db0"/></Borders></Style><Style ss:ID="s_subtitle"><Font ss:Size="10" ss:Color="#444444" ss:FontName="Calibri"/><Interior ss:Color="#f0f4ff" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#c5d3f0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#c5d3f0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#c5d3f0"/></Borders></Style><Style ss:ID="s_sechead"><Font ss:Bold="1" ss:Size="10" ss:Color="#0a58ca" ss:FontName="Calibri"/><Interior ss:Color="#e8f0ff" ss:Pattern="Solid"/><Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:Indent="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#b0c4f5"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#b0c4f5"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#0a58ca"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#b0c4f5"/></Borders></Style><Style ss:ID="s_data"><Font ss:Size="10" ss:Color="#333333" ss:FontName="Calibri"/><Interior ss:Color="#ffffff" ss:Pattern="Solid"/><Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:WrapText="1" ss:Indent="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/></Borders></Style><Style ss:ID="s_colhead"><Font ss:Bold="1" ss:Size="9" ss:Color="#FFFFFF" ss:FontName="Calibri"/><Interior ss:Color="#0a58ca" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#ffffff"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#084db0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#084db0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#084db0"/></Borders></Style><Style ss:ID="s_item"><Font ss:Size="10" ss:FontName="Calibri"/><Interior ss:Color="#ffffff" ss:Pattern="Solid"/><Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:WrapText="1" ss:Indent="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/></Borders></Style><Style ss:ID="s_item_alt"><Font ss:Size="10" ss:FontName="Calibri"/><Interior ss:Color="#f5f8ff" ss:Pattern="Solid"/><Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:WrapText="1" ss:Indent="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/></Borders></Style><Style ss:ID="s_num"><Font ss:Size="10" ss:FontName="Calibri"/><NumberFormat ss:Format="#,##0.00"/><Interior ss:Color="#ffffff" ss:Pattern="Solid"/><Alignment ss:Horizontal="Right" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/></Borders></Style><Style ss:ID="s_num_alt"><Font ss:Size="10" ss:FontName="Calibri"/><NumberFormat ss:Format="#,##0.00"/><Interior ss:Color="#f5f8ff" ss:Pattern="Solid"/><Alignment ss:Horizontal="Right" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/></Borders></Style><Style ss:ID="s_center"><Font ss:Size="10" ss:FontName="Calibri"/><Interior ss:Color="#ffffff" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/></Borders></Style><Style ss:ID="s_center_alt"><Font ss:Size="10" ss:FontName="Calibri"/><Interior ss:Color="#f5f8ff" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/></Borders></Style><Style ss:ID="s_subtotal"><Font ss:Bold="1" ss:Size="10" ss:FontName="Calibri"/><NumberFormat ss:Format="#,##0.00"/><Interior ss:Color="#dce6ff" ss:Pattern="Solid"/><Alignment ss:Horizontal="Right" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#b0c4f5"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#0a58ca"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#b0c4f5"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#b0c4f5"/></Borders></Style><Style ss:ID="s_subtotal_lbl"><Font ss:Bold="1" ss:Size="10" ss:FontName="Calibri"/><Interior ss:Color="#dce6ff" ss:Pattern="Solid"/><Alignment ss:Horizontal="Right" ss:Vertical="Center" ss:Indent="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#b0c4f5"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#0a58ca"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#b0c4f5"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#b0c4f5"/></Borders></Style><Style ss:ID="s_grandtotal"><Font ss:Bold="1" ss:Size="11" ss:Color="#FFFFFF" ss:FontName="Calibri"/><NumberFormat ss:Format="#,##0.00"/><Interior ss:Color="#0a58ca" ss:Pattern="Solid"/><Alignment ss:Horizontal="Right" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#084db0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#084db0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#084db0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#084db0"/></Borders></Style><Style ss:ID="s_grandtotal_lbl"><Font ss:Bold="1" ss:Size="11" ss:Color="#FFFFFF" ss:FontName="Calibri"/><Interior ss:Color="#0a58ca" ss:Pattern="Solid"/><Alignment ss:Horizontal="Right" ss:Vertical="Center" ss:Indent="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#084db0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#084db0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#084db0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#084db0"/></Borders></Style><Style ss:ID="s_bank"><Font ss:Size="10" ss:FontName="Calibri"/><Interior ss:Color="#f5f8ff" ss:Pattern="Solid"/><Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:WrapText="1" ss:Indent="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#c5d3f0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#c5d3f0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#c5d3f0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#c5d3f0"/></Borders></Style><Style ss:ID="s_terms"><Font ss:Size="9" ss:Color="#444444" ss:FontName="Calibri"/><Interior ss:Color="#fffdf0" ss:Pattern="Solid"/><Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:Indent="1" ss:WrapText="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#e8e0c0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#e8e0c0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#e8e0c0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#e8e0c0"/></Borders></Style><Style ss:ID="s_sign"><Font ss:Bold="1" ss:Size="10" ss:FontName="Calibri"/><Interior ss:Color="#f8faff" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Bottom"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#1a1a1a"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#dde5ff"/></Borders></Style><Style ss:ID="s_footer"><Font ss:Size="8" ss:Color="#999999" ss:Italic="1" ss:FontName="Calibri"/><Interior ss:Color="#f5f8ff" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style><Style ss:ID="s_spacer"><Interior ss:Color="#ffffff" ss:Pattern="Solid"/></Style><Style ss:ID="s_infobox"><Font ss:Size="10" ss:Color="#0a58ca" ss:FontName="Calibri"/><Interior ss:Color="#f0f4ff" ss:Pattern="Solid"/><Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:Indent="1" ss:WrapText="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#b0c4f5"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#b0c4f5"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="3" ss:Color="#0a58ca"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#b0c4f5"/></Borders></Style></Styles><Worksheet ss:Name="GST Tax Invoice"><Table><Column ss:Index="1" ss:Width="30"/><Column ss:Index="2" ss:Width="175"/><Column ss:Index="3" ss:Width="60"/><Column ss:Index="4" ss:Width="42"/><Column ss:Index="5" ss:Width="45"/><Column ss:Index="6" ss:Width="75"/><Column ss:Index="7" ss:Width="75"/><Column ss:Index="8" ss:Width="95"/><Column ss:Index="9" ss:Width="52"/><Column ss:Index="10" ss:Width="85"/><Column ss:Index="11" ss:Width="52"/><Column ss:Index="12" ss:Width="85"/><Column ss:Index="13" ss:Width="52"/><Column ss:Index="14" ss:Width="85"/><Column ss:Index="15" ss:Width="105"/>${rows.join("")}</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><PageSetup><Layout x:Orientation="Landscape"/><PageMargins x:Bottom="0.75" x:Left="0.5" x:Right="0.5" x:Top="0.75"/></PageSetup><Print><FitWidth>1</FitWidth><FitHeight>1</FitHeight></Print><Zoom>80</Zoom></WorksheetOptions></Worksheet></Workbook>`;
}

module.exports = {
  buildGstInvoiceSpreadsheet,
  loadInvoiceDocument,
};
