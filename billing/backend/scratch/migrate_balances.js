require('dotenv').config();
const { pool } = require('../config/db');

async function migrateBalances() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    console.log("Flipping balance polarity in customers table...");
    await conn.execute("UPDATE customers SET balance = -balance");

    console.log("Flipping balance polarity in invoices table...");
    await conn.execute("UPDATE invoices SET balance = -balance, previous_balance = -previous_balance");

    await conn.commit();
    console.log("Migration completed successfully.");
  } catch (err) {
    await conn.rollback();
    console.error("Migration failed:", err);
  } finally {
    conn.release();
    pool.end();
  }
}

migrateBalances();
