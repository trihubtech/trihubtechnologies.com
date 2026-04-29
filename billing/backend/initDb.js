require("dotenv").config();
const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("Starting DB Initialization...");
  let connection;
  try {
    
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || "localhost",
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "",
      multipleStatements: true,
    });

    const dbName = process.env.DB_NAME || "trihub_db";
    console.log(`Creating database ${dbName} if not exists...`);
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    
    
    await connection.query(`USE \`${dbName}\``);

    console.log("Reading schema file...");
    const schemaSql = fs.readFileSync(path.join(__dirname, "mysql-schema.sql"), "utf-8");
    
    console.log("Executing schema setup...");
    await connection.query(schemaSql);

    console.log("Database initialized successfully!");
  } catch (err) {
    console.error("Error initializing DB:", err);
  } finally {
    if (connection) await connection.end();
  }
}

main();
