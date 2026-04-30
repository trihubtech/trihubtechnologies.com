

function errorHandler(err, req, res, next) {
  console.error("❌ Error:", err.message);

  
  if (err.status) {
    return res.status(err.status).json({
      ok: false,
      error: err.message,
      code: err.code || undefined,
    });
  }

  
  if (err.code === "ER_DUP_ENTRY") {
    return res.status(409).json({
      ok: false,
      error: "A record with this value already exists.",
    });
  }

  
  if (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_NO_REFERENCED_ROW_2") {
    return res.status(422).json({
      ok: false,
      error: "This record is referenced by other data and cannot be modified.",
    });
  }

  
  if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
    return res.status(401).json({
      ok: false,
      error: "Invalid or expired token.",
    });
  }

  
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      ok: false,
      error: "File too large. Maximum size is 5MB.",
    });
  }

  
  const message =
    process.env.NODE_ENV === "production"
      ? "Internal server error."
      : err.message || "Something went wrong.";

  res.status(500).json({ ok: false, error: message });
}

module.exports = errorHandler;
