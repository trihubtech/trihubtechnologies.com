require("dotenv").config();
const { pool } = require("../config/db");
async function test() {
  const [rows] = await pool.execute("SELECT created_at FROM activities ORDER BY id DESC LIMIT 5");
  console.log("Raw from pool:", rows);
  console.log("JSON stringified:", JSON.stringify(rows, null, 2));
  process.exit(0);
}
test();
