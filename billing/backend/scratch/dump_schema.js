require('dotenv').config({ path: '../.env' });
const pool = require('../config/db').pool;
async function run() {
  try {
    console.log("--- CUSTOMERS ---");
    const [c] = await pool.query("SHOW CREATE TABLE customers");
    console.log(c[0]['Create Table']);
    
    console.log("\n--- VENDORS ---");
    const [v] = await pool.query("SHOW CREATE TABLE vendors");
    console.log(v[0]['Create Table']);

    console.log("\n--- INVOICES ---");
    const [i] = await pool.query("SHOW CREATE TABLE invoices");
    console.log(i[0]['Create Table']);

    console.log("\n--- BILLS ---");
    const [b] = await pool.query("SHOW CREATE TABLE bills");
    console.log(b[0]['Create Table']);

    console.log("\n--- PAYMENTS ---");
    const [p] = await pool.query("SHOW CREATE TABLE payments");
    console.log(p[0]['Create Table']);
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}
run();
