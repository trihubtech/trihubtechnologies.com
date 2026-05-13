const { round2 } = require("./helpers");

function cleanText(value) {
  if (value == null) return "";
  return String(value).trim();
}

const { INDIA_TIME_ZONE } = require("./time");

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { timeZone: INDIA_TIME_ZONE });
}

function buildExcelSafeText(value) {
  return cleanText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  return cell(round2(value), { styleId, type: "Number" });
}

function buildGstReportSpreadsheet(reportData, typeLabel, companyName) {
  const { products, summary, duration_label } = reportData;

  // Group products like in the frontend for a "Product-Wise" view in Excel
  const groups = products.reduce((acc, p) => {
    const key = `${p.product_name}-${p.hsn_sac_code}-${p.gst_percentage}`;
    if (!acc[key]) {
      acc[key] = {
        product_name: p.product_name,
        product_tag: p.product_tag,
        hsn_sac_code: p.hsn_sac_code,
        gst_percentage: p.gst_percentage,
        transactions: [],
        totals: { igst: 0, cgst: 0, sgst: 0, total_gst: 0 }
      };
    }
    acc[key].transactions.push(p);
    acc[key].totals.igst += Number(p.igst_amount || 0);
    acc[key].totals.cgst += Number(p.cgst_amount || 0);
    acc[key].totals.sgst += Number(p.sgst_amount || 0);
    acc[key].totals.total_gst += Number(p.total_gst_amount || 0);
    return acc;
  }, {});

  const groupedProducts = Object.values(groups);

  const rows = [
    buildSpreadsheetRow([cell(`GST ${typeLabel} Report`, { styleId: "s_title", mergeAcross: 11 })], { height: 40 }),
    buildSpreadsheetRow([cell(`Company: ${companyName}`, { styleId: "s_subtitle", mergeAcross: 11 })], { height: 20 }),
    buildSpreadsheetRow([cell(`Period: ${duration_label}`, { styleId: "s_subtitle", mergeAcross: 11 })], { height: 20 }),
    buildSpreadsheetRow([cell("", { styleId: "s_spacer", mergeAcross: 11 })], { height: 10 }),
    
    // Global Summary Section
    buildSpreadsheetRow([cell("OVERALL SUMMARY", { styleId: "s_sechead", mergeAcross: 11 })]),
    buildSpreadsheetRow([
      cell("Total IGST", { styleId: "s_colhead", mergeAcross: 2 }),
      cell("Total CGST", { styleId: "s_colhead", mergeAcross: 2 }),
      cell("Total SGST", { styleId: "s_colhead", mergeAcross: 2 }),
      cell("Grand Total GST", { styleId: "s_colhead", mergeAcross: 2 }),
    ]),
    buildSpreadsheetRow([
      moneyCell(summary.total_igst, { styleId: "s_grandtotal", mergeAcross: 2 }),
      moneyCell(summary.total_cgst, { styleId: "s_grandtotal", mergeAcross: 2 }),
      moneyCell(summary.total_sgst, { styleId: "s_grandtotal", mergeAcross: 2 }),
      moneyCell(summary.grand_total_gst, { styleId: "s_grandtotal", mergeAcross: 2 }),
    ], { height: 28 }),
    buildSpreadsheetRow([cell("", { styleId: "s_spacer", mergeAcross: 11 })], { height: 15 }),

    // Column Headers
    buildSpreadsheetRow([
      cell("Date / Product", { styleId: "s_colhead" }),
      cell("Doc No / HSN", { styleId: "s_colhead" }),
      cell("Tag / Rate", { styleId: "s_colhead" }),
      cell("Rate (₹)", { styleId: "s_colhead" }),
      cell("GST %", { styleId: "s_colhead" }),
      cell("Type", { styleId: "s_colhead" }),
      cell("IGST (₹)", { styleId: "s_colhead" }),
      cell("CGST (₹)", { styleId: "s_colhead" }),
      cell("SGST (₹)", { styleId: "s_colhead" }),
      cell("Tax Value (₹)", { styleId: "s_colhead" }),
    ], { height: 30 }),
  ];

  groupedProducts.forEach(group => {
    // Product Header row
    rows.push(buildSpreadsheetRow([
      cell(group.product_name, { styleId: "s_prodhead" }),
      cell(`HSN: ${group.hsn_sac_code || "-"}`, { styleId: "s_prodhead" }),
      cell(`GST: ${group.gst_percentage}%`, { styleId: "s_prodhead" }),
      cell("", { styleId: "s_prodhead" }),
      cell("", { styleId: "s_prodhead" }),
      cell("TOTALS:", { styleId: "s_prodhead", type: "String" }),
      moneyCell(group.totals.igst, { styleId: "s_prodhead_num" }),
      moneyCell(group.totals.cgst, { styleId: "s_prodhead_num" }),
      moneyCell(group.totals.sgst, { styleId: "s_prodhead_num" }),
      moneyCell(group.totals.total_gst, { styleId: "s_prodhead_num" }),
    ], { height: 26 }));

    // Transaction rows
    group.transactions.forEach(p => {
      rows.push(buildSpreadsheetRow([
        cell(formatDate(p.transaction_date), { styleId: "s_data" }),
        cell(p.invoice_number, { styleId: "s_data" }),
        cell(p.product_tag || "", { styleId: "s_data" }),
        moneyCell(p.rate, { styleId: "s_num" }),
        cell(p.gst_percentage, { styleId: "s_center", type: "Number" }),
        cell(p.igst_amount > 0 ? "IGST" : "CGST+SGST", { styleId: "s_center" }),
        moneyCell(p.igst_amount, { styleId: "s_num" }),
        moneyCell(p.cgst_amount, { styleId: "s_num" }),
        moneyCell(p.sgst_amount, { styleId: "s_num" }),
        moneyCell(p.total_gst_amount, { styleId: "s_num_bold" }),
      ]));
    });
    rows.push(buildSpreadsheetRow([cell("", { styleId: "s_spacer", mergeAcross: 11 })], { height: 5 }));
  });

  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:html="http://www.w3.org/TR/REC-html40"><Styles><Style ss:ID="s_title"><Font ss:Bold="1" ss:Size="18" ss:Color="#FFFFFF" ss:FontName="Calibri"/><Interior ss:Color="#0d6efd" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style><Style ss:ID="s_subtitle"><Font ss:Size="10" ss:Color="#666666" ss:FontName="Calibri"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style><Style ss:ID="s_sechead"><Font ss:Bold="1" ss:Size="10" ss:Color="#0d6efd" ss:FontName="Calibri"/><Interior ss:Color="#e8f0ff" ss:Pattern="Solid"/><Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:Indent="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#0d6efd"/></Borders></Style><Style ss:ID="s_prodhead"><Font ss:Bold="1" ss:Size="10" ss:Color="#333333" ss:FontName="Calibri"/><Interior ss:Color="#f1f5f9" ss:Pattern="Solid"/><Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:Indent="1"/><Borders><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#cbd5e1"/><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#cbd5e1"/></Borders></Style><Style ss:ID="s_prodhead_num"><Font ss:Bold="1" ss:Size="10" ss:Color="#0d6efd" ss:FontName="Calibri"/><NumberFormat ss:Format="#,##0.00"/><Interior ss:Color="#f1f5f9" ss:Pattern="Solid"/><Alignment ss:Horizontal="Right" ss:Vertical="Center"/><Borders><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#cbd5e1"/><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#cbd5e1"/></Borders></Style><Style ss:ID="s_colhead"><Font ss:Bold="1" ss:Size="9" ss:Color="#FFFFFF" ss:FontName="Calibri"/><Interior ss:Color="#334155" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/></Style><Style ss:ID="s_data"><Font ss:Size="9" ss:FontName="Calibri"/><Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:Indent="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#f1f5f9"/></Borders></Style><Style ss:ID="s_num"><Font ss:Size="9" ss:FontName="Calibri"/><NumberFormat ss:Format="#,##0.00"/><Alignment ss:Horizontal="Right" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#f1f5f9"/></Borders></Style><Style ss:ID="s_num_bold"><Font ss:Bold="1" ss:Size="9" ss:FontName="Calibri"/><NumberFormat ss:Format="#,##0.00"/><Alignment ss:Horizontal="Right" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#f1f5f9"/></Borders></Style><Style ss:ID="s_center"><Font ss:Size="9" ss:FontName="Calibri"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#f1f5f9"/></Borders></Style><Style ss:ID="s_grandtotal"><Font ss:Bold="1" ss:Size="12" ss:Color="#000000" ss:FontName="Calibri"/><NumberFormat ss:Format="#,##0.00"/><Interior ss:Color="#f8fafc" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Borders><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#0d6efd"/></Borders></Style><Style ss:ID="s_spacer"><Interior ss:Color="#ffffff" ss:Pattern="Solid"/></Style></Styles><Worksheet ss:Name="GST Report"><Table><Column ss:Width="80"/><Column ss:Width="100"/><Column ss:Width="100"/><Column ss:Width="80"/><Column ss:Width="50"/><Column ss:Width="80"/><Column ss:Width="80"/><Column ss:Width="80"/><Column ss:Width="80"/><Column ss:Width="90"/>${rows.join("")}</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><PageSetup><Layout x:Orientation="Landscape"/></PageSetup></WorksheetOptions></Worksheet></Workbook>`;
}

module.exports = {
  buildGstReportSpreadsheet,
};
