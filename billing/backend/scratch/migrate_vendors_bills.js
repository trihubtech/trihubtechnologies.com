require('dotenv').config({ path: '../.env' });
const pool = require('../config/db').pool;

async function run() {
  try {
    console.log("Adding balance to vendors...");
    await pool.query("ALTER TABLE vendors ADD COLUMN balance DECIMAL(12,2) NOT NULL DEFAULT '0.00'");
    console.log("Success.");
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') console.log("Field vendors.balance already exists.");
    else console.error(err);
  }

  try {
    console.log("Adding previous_balance to bills...");
    await pool.query("ALTER TABLE bills ADD COLUMN previous_balance DECIMAL(12,2) NOT NULL DEFAULT '0.00'");
    console.log("Success.");
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') console.log("Field bills.previous_balance already exists.");
    else console.error(err);
  }

  process.exit(0);
}

run();
