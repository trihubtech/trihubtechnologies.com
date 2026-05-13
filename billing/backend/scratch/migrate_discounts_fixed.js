require("dotenv").config();
const mysql = require("mysql2/promise");

async function migrate() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "trihub_db",
  });

  try {
    const tables = ["invoices", "bills"];
    for (const table of tables) {
      console.log(`Migrating ${table}...`);
      try {
        await connection.query(`ALTER TABLE ${table} ADD COLUMN discount_type ENUM('PERCENTAGE','AMOUNT') NOT NULL DEFAULT 'PERCENTAGE' AFTER discount`);
        console.log(`Added discount_type to ${table}`);
      } catch (e) { console.log(`${table}.discount_type likely exists`); }

      try {
        await connection.query(`ALTER TABLE ${table} ADD COLUMN discount_input DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER discount_type`);
        console.log(`Added discount_input to ${table}`);
      } catch (e) { console.log(`${table}.discount_input likely exists`); }
    }
    console.log("Migration successful!");
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    await connection.end();
  }
}

migrate();
