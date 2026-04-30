require("dotenv").config();
const { pool } = require("../config/db");

async function test() {
  const [rows] = await pool.execute("SELECT NOW() as now, @@global.time_zone as global_tz, @@session.time_zone as session_tz");
  console.log("DB Time:", rows[0]);

  const [activities] = await pool.execute("SELECT id, created_at FROM activities ORDER BY id DESC LIMIT 1");
  console.log("Latest Activity:", activities[0]);

  console.log("Activity JSON:", JSON.stringify(activities[0]));
  
  process.exit(0);
}

test();
