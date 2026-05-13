const { calculateInvoiceTaxes, round2 } = require("../utils/gst");

function test() {
  const items = [
    { rate: 100, quantity: 1, gstRate: 18 },
    { rate: 200, quantity: 2, gstRate: 12 },
  ];
  
  const resultIntra = calculateInvoiceTaxes({
    items,
    companyStateCode: "29",
    placeOfSupplyStateCode: "29",
    isExport: false
  });
  
  console.log("--- Intra State (CGST + SGST) ---");
  console.log("Total Taxable:", resultIntra.totals.taxableTotal);
  console.log("Total CGST:", resultIntra.totals.totalCgst);
  console.log("Total SGST:", resultIntra.totals.totalSgst);
  console.log("Total IGST:", resultIntra.totals.totalIgst);
  console.log("Total Tax:", resultIntra.totals.totalTax);
  
  const resultInter = calculateInvoiceTaxes({
    items,
    companyStateCode: "29",
    placeOfSupplyStateCode: "07",
    isExport: false
  });
  
  console.log("\n--- Inter State (IGST) ---");
  console.log("Total Taxable:", resultInter.totals.taxableTotal);
  console.log("Total CGST:", resultInter.totals.totalCgst);
  console.log("Total SGST:", resultInter.totals.totalSgst);
  console.log("Total IGST:", resultInter.totals.totalIgst);
  console.log("Total Tax:", resultInter.totals.totalTax);
}

test();
