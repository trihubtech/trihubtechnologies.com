


function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}




const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];
const TENS_W = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function convertHundreds(n) {
  if (n === 0) return "";
  if (n < 20)  return ONES[n];
  if (n < 100) return TENS_W[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
  return ONES[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " + convertHundreds(n % 100) : "");
}

function convertIndian(n) {
  if (n === 0)  return "";
  if (n < 1000) return convertHundreds(n);
  const crore = Math.floor(n / 10000000);
  const lakh  = Math.floor((n % 10000000) / 100000);
  const thou  = Math.floor((n % 100000) / 1000);
  const rest  = n % 1000;
  let r = "";
  if (crore) r += convertHundreds(crore) + " Crore ";
  if (lakh)  r += convertHundreds(lakh)  + " Lakh ";
  if (thou)  r += convertHundreds(thou)  + " Thousand ";
  if (rest)  r += convertHundreds(rest);
  return r.trim();
}

function numberToWords(amount) {
  if (isNaN(amount) || amount < 0) return "";
  const rupees = Math.floor(amount);
  const paise  = Math.round((amount - rupees) * 100);
  if (rupees === 0 && paise === 0) return "Zero Rupees Only";
  let result = "";
  if (rupees > 0) result += convertIndian(rupees) + " Rupee" + (rupees > 1 ? "s" : "");
  if (paise  > 0) result += (rupees > 0 ? " and " : "") + convertIndian(paise) + " Paise";
  return result + " Only";
}

module.exports = { round2, numberToWords };
