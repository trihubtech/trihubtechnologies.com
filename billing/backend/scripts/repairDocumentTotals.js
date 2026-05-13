require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const mysql = require("mysql2/promise");
const { round2, numberToWords } = require("../utils/helpers");

function calculateTotals(items, discount, paidAmount) {
  const subTotal = round2(items.reduce((sum, item) => sum + Number(item.value ?? 0), 0));
  const totalTax = round2(items.reduce((sum, item) => sum + Number(item.tax_value ?? 0), 0));
  const rawGrand = round2(subTotal + totalTax);
  const grandTotal = round2(Math.round(rawGrand));
  const roundOff = round2(grandTotal - rawGrand);
  const balance = round2(Math.max(grandTotal - paidAmount, 0));
  const status = balance <= 0 ? "PAID" : (paidAmount > 0 ? "PARTIAL" : "UNPAID");

  return {
    subTotal,
    totalTax,
    roundOff,
    grandTotal,
    amountInWords: numberToWords(grandTotal),
    balance,
    status,
  };
}

async function repairDocuments(conn, config) {
  const [documents] = await conn.execute(
    `SELECT id, discount, paid_amount FROM ${config.table} ORDER BY id ASC`
  );

  let repaired = 0;

  for (const doc of documents) {
    const discount = round2(Number(doc.discount) || 0);
    const paidAmount = round2(Number(doc.paid_amount) || 0);
    const [items] = await conn.execute(
      `SELECT value, tax_value FROM ${config.itemTable} WHERE ${config.foreignKey} = ? ORDER BY id ASC`,
      [doc.id]
    );

    const totals = calculateTotals(items, discount, paidAmount);

    await conn.execute(
      `UPDATE ${config.table}
       SET sub_total = ?, total_tax = ?, round_off = ?, grand_total = ?,
           amount_in_words = ?, balance = ?, status = ?
       WHERE id = ?`,
      [
        totals.subTotal,
        totals.totalTax,
        totals.roundOff,
        totals.grandTotal,
        totals.amountInWords,
        totals.balance,
        totals.status,
        doc.id,
      ]
    );

    repaired += 1;
  }

  return repaired;
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "3306", 10),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "trihub",
    timezone: "+05:30",
    charset: "utf8mb4",
    decimalNumbers: true,
  });

  try {
    await conn.beginTransaction();

    const invoices = await repairDocuments(conn, {
      table: "invoices",
      itemTable: "invoice_items",
      foreignKey: "invoice_id",
    });

    const bills = await repairDocuments(conn, {
      table: "bills",
      itemTable: "bill_items",
      foreignKey: "bill_id",
    });

    await conn.commit();

    console.log(`Repaired ${invoices} invoices and ${bills} bills.`);
  } catch (error) {
    await conn.rollback();
    console.error("Failed to repair document totals:", error);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
}

main();
