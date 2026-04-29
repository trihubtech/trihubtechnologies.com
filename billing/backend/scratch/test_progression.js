const { pool } = require('../config/db');

async function testProgression() {
  const conn = await pool.getConnection();
  try {
    const [custRes] = await conn.execute(
      "INSERT INTO customers (user_id, code, salutation, name, mobile, address) VALUES (1, 'TESTC', 'Mr.', 'Test Customer', '1234567890', 'Test Addr')"
    );
    const customerId = custRes.insertId;

    console.log("Customer ID:", customerId);

    await conn.execute("UPDATE customers SET balance = balance + ? - ? WHERE id = ?", [100, 150, customerId]);
    let [[cust]] = await conn.execute("SELECT balance FROM customers WHERE id = ?", [customerId]);
    console.log("After Inv 1 (100 total, 150 paid):", cust.balance);

    await conn.execute("UPDATE customers SET balance = balance + ? - ? WHERE id = ?", [200, 0, customerId]);
    [[cust]] = await conn.execute("SELECT balance FROM customers WHERE id = ?", [customerId]);
    console.log("After Inv 2 (200 total, 0 paid):", cust.balance);

    await conn.execute("UPDATE customers SET balance = balance + ? - ? WHERE id = ?", [50, 100, customerId]);
    [[cust]] = await conn.execute("SELECT balance FROM customers WHERE id = ?", [customerId]);
    console.log("After Inv 3 (50 total, 100 paid):", cust.balance);

    await conn.execute("DELETE FROM customers WHERE id = ?", [customerId]);
  } catch (err) {
    console.error(err);
  } finally {
    conn.release();
    pool.end();
  }
}

testProgression();
