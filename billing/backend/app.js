require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

const { pool } = require("./config/db");
const errorHandler = require("./middleware/errorHandler");
const { requireAuth } = require("./middleware/auth");
const { syncPermissionCatalog } = require("./utils/tenancy");

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://trihubtechnologies.com",
    "https://trihubtechnologies-com.onrender.com"
  ],
  credentials: true,
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { ok: false, error: "Too many requests, please try again later." },
});
app.use("/api/", limiter);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(morgan("dev"));

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", requireAuth, express.static(uploadsDir));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/subscription", require("./routes/subscription"));

app.use("/api/invoices", requireAuth, require("./routes/invoices"));
app.use("/api/bills", requireAuth, require("./routes/bills"));
app.use("/api/products", requireAuth, require("./routes/products"));
app.use("/api/inventory", requireAuth, require("./routes/inventory"));
app.use("/api/customers", requireAuth, require("./routes/customers"));
app.use("/api/vendors", requireAuth, require("./routes/vendors"));
app.use("/api/dashboard", requireAuth, require("./routes/dashboard"));
app.use("/api/reports", requireAuth, require("./routes/reports"));
app.use("/api/profile", requireAuth, require("./routes/profile"));
app.use("/api/company-users", requireAuth, require("./routes/companyUsers"));
app.use("/api/chat", requireAuth, require("./routes/chat"));
app.use("/api/admin", require("./routes/admin"));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "TriHub API is running", timestamp: new Date().toISOString() });
});

app.use(errorHandler);

const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    await syncPermissionCatalog(pool);
    console.log("Permission catalog synced");

    app.listen(PORT, () => {
      console.log(`TriHub API running on port ${PORT}`);
      console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
    });
  } catch (error) {
    console.error("Failed to sync permission catalog:", error.message);
    process.exit(1);
  }
}

startServer();

module.exports = app;
