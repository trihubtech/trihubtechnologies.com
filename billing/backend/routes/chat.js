const router = require("express").Router();
const { pool } = require("../config/db");
const { body, validationResult } = require("express-validator");

router.get("/", async (req, res, next) => {
  try {
    const user = req.user;
    if (!user.company_id) {
      return res.status(403).json({ ok: false, error: "You are not associated with a company." });
    }

    const [messages] = await pool.execute(
      `SELECT c.id, c.message, c.created_at, u.id AS sender_id, u.name AS sender_name, u.profile_picture AS sender_avatar, u.role AS sender_role
       FROM company_chats c
       INNER JOIN users u ON c.sender_id = u.id
       WHERE c.company_id = ?
       ORDER BY c.created_at ASC
       LIMIT 500`,
      [user.company_id]
    );

    return res.json({ ok: true, data: messages });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/",
  [
    body("message").trim().notEmpty().withMessage("Message is required"),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ ok: false, error: "Validation failed", details: errors.mapped() });
    }

    try {
      const user = req.user;
      if (!user.company_id) {
        return res.status(403).json({ ok: false, error: "You are not associated with a company." });
      }

      const [result] = await pool.execute(
        "INSERT INTO company_chats (company_id, sender_id, message) VALUES (?, ?, ?)",
        [user.company_id, user.member_id, req.body.message]
      );

      const [newMessage] = await pool.execute(
        `SELECT c.id, c.message, c.created_at, u.id AS sender_id, u.name AS sender_name, u.profile_picture AS sender_avatar, u.role AS sender_role
         FROM company_chats c
         INNER JOIN users u ON c.sender_id = u.id
         WHERE c.id = ?`,
        [result.insertId]
      );

      return res.json({ ok: true, data: newMessage[0] });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
