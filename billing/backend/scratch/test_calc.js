const round2 = (n) => Math.round(Number(n) * 100) / 100;

function calcInvoiceTotals(items, discount) {
  const subTotal = round2(items.reduce((s, i) => s + Number(i.value ?? 0), 0));
  const totalTax = round2(items.reduce((s, i) => s + Number(i.taxValue ?? i.tax_value ?? 0), 0));
  const rawGrand = subTotal - discount + totalTax;
  const grandTotal = round2(Math.round(rawGrand));
  const roundOff  = round2(grandTotal - rawGrand);
  return { subTotal, totalTax, roundOff, grandTotal };
}

const items = [
  { value: 100, tax_value: 18 }
];
const discount = 0;

console.log(calcInvoiceTotals(items, discount));
