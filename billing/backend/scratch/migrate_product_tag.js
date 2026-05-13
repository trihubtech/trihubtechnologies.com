require("dotenv").config({ path: "Backend/.env" });
const { pool } = require("../config/db");

async function columnExists(table, column) {
  const [rows] = await pool.execute(`
    SELECT COUNT(*) as count 
    FROM information_schema.columns 
    WHERE table_schema = DATABASE() 
    AND table_name = ? 
    AND column_name = ?
  `, [table, column]);
  return rows[0].count > 0;
}

async function migrate() {
  try {
    console.log("Starting migration: Adding product_tag...");

    if (!await columnExists('products', 'product_tag')) {
      await pool.execute(`ALTER TABLE products ADD COLUMN product_tag VARCHAR(100) NULL AFTER category`);
      console.log("- Added product_tag to products");
    } else {
      console.log("- product_tag already exists in products");
    }

    if (!await columnExists('invoice_items', 'product_tag')) {
      await pool.execute(`ALTER TABLE invoice_items ADD COLUMN product_tag VARCHAR(100) NULL AFTER hsn_sac_code`);
      console.log("- Added product_tag to invoice_items");
    } else {
      console.log("- product_tag already exists in invoice_items");
    }

    if (!await columnExists('bill_items', 'product_tag')) {
      await pool.execute(`ALTER TABLE bill_items ADD COLUMN product_tag VARCHAR(100) NULL AFTER hsn_sac_code`);
      console.log("- Added product_tag to bill_items");
    } else {
      console.log("- product_tag already exists in bill_items");
    }

    console.log("Migration completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
}

migrate();
