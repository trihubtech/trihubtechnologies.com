const GST_RATE_OPTIONS = [0, 0.25, 1.5, 3, 5, 12, 18, 28, 40];

const INDIAN_STATES = [
  { code: "01", name: "Jammu and Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu" },
  { code: "27", name: "Maharashtra" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman and Nicobar Islands" },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh" },
  { code: "96", name: "Foreign Country" },
  { code: "97", name: "Other Territory" },
  { code: "99", name: "Centre Jurisdiction" },
];

const STATE_BY_CODE = new Map(INDIAN_STATES.map((state) => [state.code, state]));
const STATE_BY_NAME = new Map(INDIAN_STATES.map((state) => [state.name.toLowerCase(), state]));

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function round3(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function cleanOptional(value) {
  if (typeof value !== "string") {
    return value == null ? null : String(value).trim() || null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeCountry(value) {
  const cleaned = cleanOptional(value);
  return cleaned || "India";
}

function isIndianCountry(value) {
  return normalizeCountry(value).toLowerCase() === "india";
}

function normalizeStateCode(value) {
  const cleaned = cleanOptional(value);
  if (!cleaned) return null;
  const digitsOnly = cleaned.replace(/\D/g, "");
  if (!digitsOnly) return null;
  return digitsOnly.padStart(2, "0").slice(-2);
}

function findStateByCode(value) {
  const code = normalizeStateCode(value);
  if (!code) return null;
  return STATE_BY_CODE.get(code) || null;
}

function findStateByName(value) {
  const cleaned = cleanOptional(value);
  if (!cleaned) return null;
  return STATE_BY_NAME.get(cleaned.toLowerCase()) || null;
}

function normalizeGstin(value) {
  const cleaned = cleanOptional(value);
  return cleaned ? cleaned.toUpperCase() : null;
}

function deriveStateFromGstin(gstin) {
  const normalized = normalizeGstin(gstin);
  if (!normalized || normalized.length < 2) return null;
  return findStateByCode(normalized.slice(0, 2));
}

function validateGstin(value) {
  const normalized = normalizeGstin(value);
  if (!normalized) return true;
  return /^[0-9]{2}[A-Z0-9]{13}$/.test(normalized);
}

function isValidGstRate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
    return false;
  }

  return Math.round(numeric * 1000) === numeric * 1000;
}

function formatSupplyType({
  isExport,
  companyStateCode,
  placeOfSupplyStateCode,
  internationalSupplyType = "EXPORT",
}) {
  if (isExport) return internationalSupplyType;
  if (!companyStateCode || !placeOfSupplyStateCode) return "INTER_STATE";
  return companyStateCode === placeOfSupplyStateCode ? "INTRA_STATE" : "INTER_STATE";
}

function calcExclusiveRate(rate, gstRate, priceIncludesGst) {
  const normalizedRate = round2(rate);
  const normalizedGstRate = Number(gstRate || 0);

  if (!priceIncludesGst || normalizedGstRate <= 0) {
    return normalizedRate;
  }

  return round2(normalizedRate / (1 + normalizedGstRate / 100));
}

function buildRateBreakup(gstRate, supplyType) {
  const normalizedGstRate = round2(gstRate);

  if (supplyType === "EXPORT" || supplyType === "INTER_STATE") {
    return {
      cgstRate: 0,
      sgstRate: 0,
      igstRate: round3(normalizedGstRate),
    };
  }

  if (supplyType === "INTRA_STATE") {
    const halfRate = round3(normalizedGstRate / 2);
    return {
      cgstRate: halfRate,
      sgstRate: halfRate,
      igstRate: 0,
    };
  }

  return {
    cgstRate: 0,
    sgstRate: 0,
    igstRate: 0,
  };
}

function allocateDiscounts(baseValues, discount) {
  const normalizedBaseValues = baseValues.map((value) => round2(value));
  const totalBaseValue = round2(normalizedBaseValues.reduce((sum, value) => sum + value, 0));
  const targetDiscount = Math.min(round2(discount), totalBaseValue);

  if (targetDiscount <= 0 || totalBaseValue <= 0) {
    return normalizedBaseValues.map(() => 0);
  }

  let remainingDiscount = targetDiscount;

  return normalizedBaseValues.map((baseValue, index) => {
    if (index === normalizedBaseValues.length - 1) {
      return round2(Math.min(baseValue, remainingDiscount));
    }

    const proportionalDiscount = round2(targetDiscount * (baseValue / totalBaseValue));
    const appliedDiscount = round2(Math.min(baseValue, remainingDiscount, proportionalDiscount));
    remainingDiscount = round2(remainingDiscount - appliedDiscount);
    return appliedDiscount;
  });
}

function calculateInvoiceTaxes({
  items,
  discount = 0,
  companyStateCode,
  placeOfSupplyStateCode,
  isExport = false,
  priceIncludesGst = false,
  internationalSupplyType = "EXPORT",
}) {
  const supplyType = formatSupplyType({
    isExport,
    companyStateCode: normalizeStateCode(companyStateCode),
    placeOfSupplyStateCode: normalizeStateCode(placeOfSupplyStateCode),
    internationalSupplyType,
  });

  const seededItems = items.map((item) => {
    const rate = round2(item.rate);
    const quantity = round2(item.quantity);
    const gstRate = round2(item.gstRate);
    const exclusiveRate = calcExclusiveRate(rate, gstRate, priceIncludesGst);
    const baseValue = round2(exclusiveRate * quantity);

    return {
      ...item,
      rate,
      quantity,
      gstRate,
      exclusiveRate,
      baseValue,
    };
  });

  const baseValues = seededItems.map((item) => item.baseValue);
  const allocatedDiscounts = allocateDiscounts(baseValues, discount);

  const calculatedItems = seededItems.map((item, index) => {
    const discountValue = allocatedDiscounts[index];
    const taxableValue = round2(item.baseValue - discountValue);
    const { cgstRate, sgstRate, igstRate } = buildRateBreakup(item.gstRate, supplyType);

    let cgstAmount = 0;
    let sgstAmount = 0;
    let igstAmount = 0;
    let taxValue = 0;
    let totalValue = 0;

    if (priceIncludesGst) {
      // If price includes GST, we assume the discount is on the gross price.
      // However, for consistency with exclusive logic, we apply the allocated discount to the derived base.
      taxValue = round2(taxableValue * (item.gstRate / 100)); // This is simple exclusive-style tax on net taxable
      // Wait, if price includes GST, the totalValue should be (rate * quantity) - (discount on gross).
      // Let's stick to the allocated discount on base value for consistency.
      if (igstRate > 0) {
        igstAmount = taxValue;
      } else if (cgstRate > 0 && sgstRate > 0) {
        cgstAmount = round2(taxValue / 2);
        sgstAmount = round2(taxValue - cgstAmount);
      }
      totalValue = round2(taxableValue + taxValue);
    } else {
      cgstAmount = round2(taxableValue * (cgstRate / 100));
      sgstAmount = round2(taxableValue * (sgstRate / 100));
      igstAmount = round2(taxableValue * (igstRate / 100));
      taxValue = round2(cgstAmount + sgstAmount + igstAmount);
      totalValue = round2(taxableValue + taxValue);
    }

    return {
      ...item,
      discountValue,
      taxableValue,
      value: taxableValue,
      taxRate: item.gstRate,
      taxValue,
      cgstRate,
      cgstAmount,
      sgstRate,
      sgstAmount,
      igstRate,
      igstAmount,
      totalValue,
    };
  });

  const subTotal = round2(calculatedItems.reduce((sum, item) => sum + item.baseValue, 0));
  const taxableTotal = round2(calculatedItems.reduce((sum, item) => sum + item.taxableValue, 0));
  const totalCgst = round2(calculatedItems.reduce((sum, item) => sum + item.cgstAmount, 0));
  const totalSgst = round2(calculatedItems.reduce((sum, item) => sum + item.sgstAmount, 0));
  const totalIgst = round2(calculatedItems.reduce((sum, item) => sum + item.igstAmount, 0));
  const totalTax = round2(totalCgst + totalSgst + totalIgst);
  const grandTotal = round2(taxableTotal + totalTax);

  return {
    supplyType,
    items: calculatedItems,
    totals: {
      subTotal,
      discount: round2(discount),
      taxableTotal,
      totalCgst,
      totalSgst,
      totalIgst,
      totalTax,
      roundOff: 0,
      grandTotal,
    },
  };
}

module.exports = {
  GST_RATE_OPTIONS,
  INDIAN_STATES,
  allocateDiscounts,
  calcExclusiveRate,
  calculateInvoiceTaxes,
  cleanOptional,
  deriveStateFromGstin,
  findStateByCode,
  findStateByName,
  formatSupplyType,
  isIndianCountry,
  isValidGstRate,
  normalizeCountry,
  normalizeGstin,
  normalizeStateCode,
  round2,
  round3,
  validateGstin,
};
