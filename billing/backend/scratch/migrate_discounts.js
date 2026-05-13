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
    console.log("Adding discount columns to invoices...");
    await connection.query(`
      ALTER TABLE invoices 
      ADD COLUMN IF NOT EXISTS discount_type ENUM('PERCENTAGE','AMOUNT') NOT NULL DEFAULT 'PERCENTAGE' AFTER discount,
      ADD COLUMN IF NOT EXISTS discount_input DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER discount_type
    `).catch(err => console.log("Invoices columns might already exist:", err.message));

    console.log("Adding discount columns to bills...");
    await connection.query(`
      ALTER TABLE bills 
      ADD COLUMN IF NOT EXISTS discount_type ENUM('PERCENTAGE','AMOUNT') NOT NULL DEFAULT 'PERCENTAGE' AFTER discount,
      ADD COLUMN IF NOT EXISTS discount_input DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER discount_type
    `).catch(err => console.log("Bills columns might already exist:", err.message));

    console.log("Migration successful!");
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    await connection.end();
  }
}

migrate();
