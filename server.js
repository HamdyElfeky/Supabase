const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const fs = require("fs");

const app = express();
const port = Number(process.env.PORT || 10000);
const apiKey = process.env.API_KEY;
const databaseUrl = process.env.DATABASE_URL;
const emergencyResetPassword = process.env.EMERGENCY_RESET_PASSWORD || "";

if (!apiKey) {
  throw new Error("API_KEY environment variable is required");
}

if (!databaseUrl) {
  throw new Error("DATABASE_URL environment variable is required");
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false }
});

const rolePermissions = {
  admin: ["dashboard:view", "invoices:view", "products:view", "products:manage",
    "users:manage", "logs:view", "cash:view", "cash:close", "announcements:manage",
    "system:reset"],
  manager: ["dashboard:view", "invoices:view", "products:view", "products:manage",
    "logs:view", "cash:view", "cash:close"],
  cashier: ["dashboard:view", "invoices:view", "products:view", "cash:view", "cash:close"],
  viewer: ["dashboard:view", "invoices:view", "products:view", "cash:view"]
};

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function requireApiKey(req, res, next) {
  if (req.get("X-Api-Key") !== apiKey) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function publicUser(user) {
  return {
    id: Number(user.id),
    display_name: user.display_name,
    role: user.role,
    active: user.active,
    last_login_at: user.last_login_at,
    created_at: user.created_at,
    permissions: rolePermissions[user.role] || []
  };
}

async function requireSession(req, res, next) {
  const authorization = req.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const result = await pool.query(
      `SELECT u.*
       FROM user_sessions s
       JOIN app_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.active = TRUE`,
      [hashToken(authorization.slice(7))]
    );
    if (result.rowCount === 0) {
      return res.status(401).json({ ok: false, error: "Session expired" });
    }
    req.user = result.rows[0];
    next();
  } catch (error) {
    next(error);
  }
}

function requirePermission(permission) {
  return (req, res, next) => {
    const permissions = rolePermissions[req.user?.role] || [];
    if (!permissions.includes(permission)) {
      return res.status(403).json({ ok: false, error: "Permission denied" });
    }
    next();
  };
}

async function writeLog(req, action, entityType = null, entityId = null, details = {}) {
  try {
    await pool.query(
      `INSERT INTO activity_logs
         (user_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.user?.id || null, action, entityType, entityId == null ? null : String(entityId),
        JSON.stringify(details), req.ip]
    );
  } catch (error) {
    console.error("Activity log failed", error);
  }
}

async function passwordAlreadyUsed(password, excludeUserId = null) {
  const result = await pool.query(
    `SELECT id, password_hash FROM app_users
     WHERE ($1::bigint IS NULL OR id <> $1)`,
    [excludeUserId]
  );
  for (const user of result.rows) {
    if (await bcrypt.compare(password, user.password_hash)) return true;
  }
  return false;
}

async function ensureSchema() {
  await pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  const existing = await pool.query("SELECT COUNT(*)::integer AS count FROM app_users");
  if (existing.rows[0].count === 0) {
    const passwordHash = await bcrypt.hash(apiKey, 12);
    await pool.query(
      `INSERT INTO app_users (display_name, password_hash, role)
       VALUES ('المدير', $1, 'admin')`,
      [passwordHash]
    );
    console.log("Created initial admin account");
  }
}

function validateInvoiceEvent(body) {
  if (!body || body.event_type !== "INVOICE_CREATED") {
    return "Unsupported event type";
  }

  const payload = body.payload;
  if (!payload || !Number.isInteger(payload.invoice_id)) {
    return "Invalid invoice_id";
  }
  if (typeof payload.invoice_date !== "string" || payload.invoice_date.length === 0) {
    return "Invalid invoice_date";
  }
  if (!Number.isFinite(Number(payload.invoice_total)) || Number(payload.invoice_total) < 0) {
    return "Invalid invoice_total";
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return "Invoice items are required";
  }

  for (const item of payload.items) {
    if (
      typeof item.product_name !== "string" ||
      item.product_name.length === 0 ||
      !Number.isInteger(item.quantity) ||
      item.quantity <= 0 ||
      !Number.isFinite(Number(item.unit_price)) ||
      Number(item.unit_price) < 0
    ) {
      return "Invalid invoice item";
    }
  }

  return null;
}

app.get(["/api/ping", "/api/ping.php"], requireApiKey, async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (error) {
    console.error("Database ping failed", error);
    res.status(503).json({ ok: false, error: "Database unavailable" });
  }
});

app.post(["/api/sync_push", "/api/sync_push.php"], requireApiKey, async (req, res) => {
  const validationError = validateInvoiceEvent(req.body);
  if (validationError) {
    return res.status(400).json({ ok: false, error: validationError });
  }

  const body = req.body;
  const payload = body.payload;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existingEvent = await client.query(
      "SELECT id FROM sync_events WHERE sync_id = $1 AND event_type = $2",
      [body.sync_id, body.event_type]
    );

    if (existingEvent.rowCount > 0) {
      await client.query("COMMIT");
      return res.json({ ok: true, duplicate: true });
    }

    const invoiceResult = await client.query(
      `INSERT INTO invoices (local_invoice_id, invoice_date, invoice_total)
       VALUES ($1, $2, $3)
       ON CONFLICT (local_invoice_id)
       DO UPDATE SET
         invoice_date = EXCLUDED.invoice_date,
         invoice_total = EXCLUDED.invoice_total,
         updated_at = NOW()
       RETURNING id`,
      [payload.invoice_id, payload.invoice_date, payload.invoice_total]
    );

    const invoiceId = invoiceResult.rows[0].id;
    await client.query("DELETE FROM invoice_items WHERE invoice_id = $1", [invoiceId]);

    for (const item of payload.items) {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, product_name, quantity, unit_price)
         VALUES ($1, $2, $3, $4)`,
        [invoiceId, item.product_name, item.quantity, item.unit_price]
      );
    }

    await client.query(
      `INSERT INTO sync_events
         (sync_id, event_type, entity_type, entity_id, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        body.sync_id,
        body.event_type,
        body.entity_type || "invoice",
        body.entity_id,
        JSON.stringify(payload)
      ]
    );

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Invoice sync failed", error);
    res.status(500).json({ ok: false, error: "Sync failed" });
  } finally {
    client.release();
  }
});

app.post("/api/auth/login", async (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!password) {
    return res.status(400).json({ ok: false, error: "Password is required" });
  }

  try {
    const users = await pool.query("SELECT * FROM app_users WHERE active = TRUE ORDER BY id");
    let matchedUser = null;
    for (const user of users.rows) {
      if (await bcrypt.compare(password, user.password_hash)) {
        matchedUser = user;
        break;
      }
    }
    if (!matchedUser) {
      await writeLog(req, "LOGIN_FAILED", "auth", null);
      return res.status(401).json({ ok: false, error: "Invalid password" });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO user_sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
        [matchedUser.id, hashToken(token)]
      );
      await client.query(
        "UPDATE app_users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1",
        [matchedUser.id]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    req.user = matchedUser;
    await writeLog(req, "LOGIN_SUCCESS", "auth", matchedUser.id);
    res.json({ ok: true, token, user: publicUser(matchedUser) });
  } catch (error) {
    console.error("Login failed", error);
    res.status(500).json({ ok: false, error: "Login failed" });
  }
});

app.get("/api/auth/me", requireSession, (req, res) => {
  res.json({ ok: true, user: publicUser(req.user) });
});

app.post("/api/auth/logout", requireSession, async (req, res) => {
  const token = (req.get("Authorization") || "").slice(7);
  await pool.query("DELETE FROM user_sessions WHERE token_hash = $1", [hashToken(token)]);
  await writeLog(req, "LOGOUT", "auth", req.user.id);
  res.json({ ok: true });
});

app.get("/api/users", requireSession, requirePermission("users:manage"), async (_req, res) => {
  const result = await pool.query(
    `SELECT id, display_name, role, active, last_login_at, created_at, updated_at
     FROM app_users ORDER BY id`
  );
  res.json({ ok: true, users: result.rows.map(publicUser) });
});

app.post("/api/users", requireSession, requirePermission("users:manage"), async (req, res) => {
  const displayName = typeof req.body?.display_name === "string" ? req.body.display_name.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const role = req.body?.role;
  if (!displayName || password.length < 6 || !rolePermissions[role]) {
    return res.status(400).json({ ok: false, error: "Invalid user data" });
  }
  if (await passwordAlreadyUsed(password)) {
    return res.status(409).json({ ok: false, error: "Password is already used" });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    `INSERT INTO app_users (display_name, password_hash, role)
     VALUES ($1, $2, $3)
     RETURNING id, display_name, role, active, last_login_at, created_at`,
    [displayName, passwordHash, role]
  );
  await writeLog(req, "USER_CREATED", "user", result.rows[0].id,
    { display_name: displayName, role });
  res.status(201).json({ ok: true, user: publicUser(result.rows[0]) });
});

app.patch("/api/users/:userId", requireSession, requirePermission("users:manage"), async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) {
    return res.status(400).json({ ok: false, error: "Invalid user ID" });
  }
  if (userId === Number(req.user.id) && req.body.active === false) {
    return res.status(400).json({ ok: false, error: "You cannot disable your own account" });
  }

  const current = await pool.query("SELECT * FROM app_users WHERE id = $1", [userId]);
  if (current.rowCount === 0) {
    return res.status(404).json({ ok: false, error: "User not found" });
  }

  const displayName = typeof req.body.display_name === "string"
    ? req.body.display_name.trim() : current.rows[0].display_name;
  const role = rolePermissions[req.body.role] ? req.body.role : current.rows[0].role;
  const active = typeof req.body.active === "boolean" ? req.body.active : current.rows[0].active;
  let passwordHash = current.rows[0].password_hash;
  if (typeof req.body.password === "string" && req.body.password.length > 0) {
    if (req.body.password.length < 6) {
      return res.status(400).json({ ok: false, error: "Password is too short" });
    }
    if (await passwordAlreadyUsed(req.body.password, userId)) {
      return res.status(409).json({ ok: false, error: "Password is already used" });
    }
    passwordHash = await bcrypt.hash(req.body.password, 12);
  }

  const result = await pool.query(
    `UPDATE app_users
     SET display_name = $1, role = $2, active = $3, password_hash = $4, updated_at = NOW()
     WHERE id = $5
     RETURNING id, display_name, role, active, last_login_at, created_at`,
    [displayName, role, active, passwordHash, userId]
  );
  if (!active || passwordHash !== current.rows[0].password_hash) {
    await pool.query("DELETE FROM user_sessions WHERE user_id = $1 AND user_id <> $2", [userId, req.user.id]);
  }
  await writeLog(req, "USER_UPDATED", "user", userId, { display_name: displayName, role, active });
  res.json({ ok: true, user: publicUser(result.rows[0]) });
});

app.get("/api/logs", requireSession, requirePermission("logs:view"), async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const result = await pool.query(
    `SELECT l.id, l.action, l.entity_type, l.entity_id, l.details, l.ip_address,
            l.created_at, u.display_name
     FROM activity_logs l
     LEFT JOIN app_users u ON u.id = l.user_id
     ORDER BY l.id DESC LIMIT $1`,
    [limit]
  );
  res.json({ ok: true, logs: result.rows });
});

app.post("/api/logs/client", requireSession, async (req, res) => {
  const action = typeof req.body?.action === "string"
    ? req.body.action.replace(/[^A-Z0-9_]/g, "").slice(0, 80) : "";
  if (!action) {
    return res.status(400).json({ ok: false, error: "Invalid action" });
  }
  const details = req.body?.details && typeof req.body.details === "object"
    ? req.body.details : {};
  await writeLog(req, action, req.body.entity_type || "website",
    req.body.entity_id || null, details);
  res.json({ ok: true });
});

app.get("/api/announcements/pending", requireSession, async (req, res) => {
  const result = await pool.query(
    `SELECT a.id, a.title, a.message, a.created_at, u.display_name AS created_by_name
     FROM announcements a
     LEFT JOIN app_users u ON u.id = a.created_by
     LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = $1
     WHERE a.active = TRUE AND r.user_id IS NULL
     ORDER BY a.id`,
    [req.user.id]
  );
  res.json({ ok: true, announcements: result.rows });
});

app.post("/api/announcements/:announcementId/read", requireSession, async (req, res) => {
  const announcementId = Number(req.params.announcementId);
  await pool.query(
    `INSERT INTO announcement_reads (announcement_id, user_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [announcementId, req.user.id]
  );
  await writeLog(req, "ANNOUNCEMENT_CLOSED", "announcement", announcementId);
  res.json({ ok: true });
});

app.get("/api/announcements", requireSession,
  requirePermission("announcements:manage"), async (_req, res) => {
    const result = await pool.query(
      `SELECT a.id, a.title, a.message, a.active, a.created_at,
              u.display_name AS created_by_name,
              COUNT(r.user_id)::integer AS read_count
       FROM announcements a
       LEFT JOIN app_users u ON u.id = a.created_by
       LEFT JOIN announcement_reads r ON r.announcement_id = a.id
       GROUP BY a.id, u.display_name
       ORDER BY a.id DESC LIMIT 100`
    );
    res.json({ ok: true, announcements: result.rows });
  });

app.post("/api/announcements", requireSession,
  requirePermission("announcements:manage"), async (req, res) => {
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!title || !message) {
      return res.status(400).json({ ok: false, error: "Title and message are required" });
    }
    const result = await pool.query(
      `INSERT INTO announcements (title, message, created_by)
       VALUES ($1, $2, $3) RETURNING *`,
      [title, message, req.user.id]
    );
    await writeLog(req, "ANNOUNCEMENT_CREATED", "announcement", result.rows[0].id, { title });
    res.status(201).json({ ok: true, announcement: result.rows[0] });
  });

app.patch("/api/announcements/:announcementId", requireSession,
  requirePermission("announcements:manage"), async (req, res) => {
    const announcementId = Number(req.params.announcementId);
    const active = Boolean(req.body?.active);
    const result = await pool.query(
      "UPDATE announcements SET active = $1 WHERE id = $2 RETURNING *",
      [active, announcementId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Announcement not found" });
    }
    await writeLog(req, "ANNOUNCEMENT_UPDATED", "announcement", announcementId, { active });
    res.json({ ok: true, announcement: result.rows[0] });
  });

app.get("/api/device-announcement", requireApiKey, async (_req, res) => {
  const result = await pool.query(
    `SELECT id, title, message
     FROM announcements
     WHERE active = TRUE AND desktop_read_at IS NULL
     ORDER BY id
     LIMIT 1`
  );
  if (result.rowCount === 0) {
    return res.json({ ok: true, announcement: null });
  }
  const announcement = result.rows[0];
  res.json({
    ok: true,
    announcement: {
      id: Number(announcement.id),
      title_base64: Buffer.from(announcement.title, "utf8").toString("base64"),
      message_base64: Buffer.from(announcement.message, "utf8").toString("base64")
    }
  });
});

app.post("/api/device-announcement/:announcementId/read", requireApiKey, async (req, res) => {
  const announcementId = Number(req.params.announcementId);
  const result = await pool.query(
    `UPDATE announcements SET desktop_read_at = NOW()
     WHERE id = $1 RETURNING id`,
    [announcementId]
  );
  res.json({ ok: true, updated: result.rowCount > 0 });
});

app.post("/api/system/emergency-reset", requireSession,
  requirePermission("system:reset"), async (req, res) => {
    const supplied = typeof req.body?.password === "string" ? req.body.password : "";
    if (!emergencyResetPassword) {
      return res.status(503).json({ ok: false, error: "Emergency reset is not configured" });
    }
    const suppliedBuffer = Buffer.from(supplied);
    const expectedBuffer = Buffer.from(emergencyResetPassword);
    const valid = suppliedBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
    if (!valid) {
      await writeLog(req, "EMERGENCY_RESET_FAILED", "system", null);
      return res.status(401).json({ ok: false, error: "Invalid reset password" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        TRUNCATE TABLE
          announcement_reads, announcements, daily_cash_closures, products,
          sync_events, invoice_items, invoices, activity_logs
        RESTART IDENTITY CASCADE
      `);
      await client.query("COMMIT");
      await writeLog(req, "EMERGENCY_RESET_COMPLETED", "system", null);
      res.json({ ok: true });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

app.get("/api/products", requireSession, requirePermission("products:view"), async (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const values = [];
  let where = "";
  if (search) {
    values.push(`%${search}%`);
    where = "WHERE name ILIKE $1 OR COALESCE(barcode, '') ILIKE $1";
  }
  const result = await pool.query(
    `SELECT * FROM products ${where} ORDER BY active DESC, name LIMIT 500`,
    values
  );
  res.json({ ok: true, products: result.rows });
});

app.post("/api/products", requireSession, requirePermission("products:manage"), async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const salePrice = Number(req.body?.sale_price);
  const costPrice = Number(req.body?.cost_price || 0);
  const stock = Number(req.body?.stock_quantity || 0);
  const lowStock = Number(req.body?.low_stock_limit ?? 5);
  if (!name || !Number.isFinite(salePrice) || salePrice < 0 ||
      !Number.isFinite(costPrice) || costPrice < 0 ||
      !Number.isInteger(stock) || !Number.isInteger(lowStock)) {
    return res.status(400).json({ ok: false, error: "Invalid product data" });
  }
  const result = await pool.query(
    `INSERT INTO products (name, barcode, sale_price, cost_price, stock_quantity, low_stock_limit)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [name, req.body.barcode || null, salePrice, costPrice, stock, lowStock]
  );
  await writeLog(req, "PRODUCT_CREATED", "product", result.rows[0].id, { name });
  res.status(201).json({ ok: true, product: result.rows[0] });
});

app.patch("/api/products/:productId", requireSession, requirePermission("products:manage"), async (req, res) => {
  const productId = Number(req.params.productId);
  const current = await pool.query("SELECT * FROM products WHERE id = $1", [productId]);
  if (current.rowCount === 0) {
    return res.status(404).json({ ok: false, error: "Product not found" });
  }
  const product = current.rows[0];
  const values = {
    name: typeof req.body.name === "string" ? req.body.name.trim() : product.name,
    barcode: req.body.barcode === undefined ? product.barcode : (req.body.barcode || null),
    sale_price: req.body.sale_price === undefined ? product.sale_price : Number(req.body.sale_price),
    cost_price: req.body.cost_price === undefined ? product.cost_price : Number(req.body.cost_price),
    stock_quantity: req.body.stock_quantity === undefined
      ? product.stock_quantity : Number(req.body.stock_quantity),
    low_stock_limit: req.body.low_stock_limit === undefined
      ? product.low_stock_limit : Number(req.body.low_stock_limit),
    active: typeof req.body.active === "boolean" ? req.body.active : product.active
  };
  if (!values.name || !Number.isFinite(Number(values.sale_price)) ||
      !Number.isFinite(Number(values.cost_price)) ||
      !Number.isInteger(values.stock_quantity) || !Number.isInteger(values.low_stock_limit)) {
    return res.status(400).json({ ok: false, error: "Invalid product data" });
  }
  const result = await pool.query(
    `UPDATE products SET name=$1, barcode=$2, sale_price=$3, cost_price=$4,
       stock_quantity=$5, low_stock_limit=$6, active=$7, updated_at=NOW()
     WHERE id=$8 RETURNING *`,
    [values.name, values.barcode, values.sale_price, values.cost_price,
      values.stock_quantity, values.low_stock_limit, values.active, productId]
  );
  await writeLog(req, "PRODUCT_UPDATED", "product", productId, { name: values.name });
  res.json({ ok: true, product: result.rows[0] });
});

app.get("/api/products-sync", requireApiKey, async (_req, res) => {
  const result = await pool.query(
    `SELECT id, local_product_id, name, barcode, sale_price, stock_quantity, active, updated_at
     FROM products ORDER BY id`
  );
  res.json({ ok: true, products: result.rows });
});

app.post("/api/products-sync", requireApiKey, async (req, res) => {
  if (!Array.isArray(req.body?.products)) {
    return res.status(400).json({ ok: false, error: "Products are required" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receivedIds = [];
    for (const product of req.body.products) {
      if (!Number.isInteger(product.product_id) || typeof product.name !== "string") continue;
      receivedIds.push(product.product_id);
      await client.query(
        `INSERT INTO products
           (local_product_id, name, barcode, sale_price, stock_quantity, active, source)
         VALUES ($1, $2, $3, $4, $5, TRUE, 'desktop')
         ON CONFLICT (local_product_id) DO UPDATE SET
           name=EXCLUDED.name, barcode=EXCLUDED.barcode, sale_price=EXCLUDED.sale_price,
           stock_quantity=EXCLUDED.stock_quantity, active=TRUE, source='desktop', updated_at=NOW()`,
        [product.product_id, product.name, product.barcode || null,
          Number(product.sale_price || 0), Number(product.stock_quantity || 0)]
      );
    }
    if (receivedIds.length > 0) {
      await client.query(
        `UPDATE products SET active=FALSE, updated_at=NOW()
         WHERE source='desktop' AND NOT (local_product_id = ANY($1::integer[]))`,
        [receivedIds]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true, count: receivedIds.length });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Product sync failed", error);
    res.status(500).json({ ok: false, error: "Product sync failed" });
  } finally {
    client.release();
  }
});

app.get("/api/cash-report", requireSession, requirePermission("cash:view"), async (req, res) => {
  const date = typeof req.query.date === "string" ? req.query.date : new Date().toISOString().slice(0, 10);
  const [sales, closure] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::integer AS invoice_count,
              COALESCE(SUM(invoice_total), 0)::numeric AS expected_cash
       FROM invoices WHERE LEFT(invoice_date, 10) = $1`,
      [date]
    ),
    pool.query(
      `SELECT c.*, u.display_name AS closed_by_name
       FROM daily_cash_closures c LEFT JOIN app_users u ON u.id = c.closed_by
       WHERE c.business_date = $1`,
      [date]
    )
  ]);
  const report = sales.rows[0];
  const close = closure.rows[0] || null;
  res.json({
    ok: true,
    report: {
      business_date: date,
      invoice_count: report.invoice_count,
      expected_cash: report.expected_cash,
      actual_cash: close?.actual_cash ?? null,
      variance: close ? Number(close.actual_cash) - Number(report.expected_cash) : null,
      notes: close?.notes || "",
      closed_by_name: close?.closed_by_name || null,
      closed_at: close?.updated_at || null
    }
  });
});

app.post("/api/cash-report/close", requireSession, requirePermission("cash:close"), async (req, res) => {
  const date = typeof req.body?.business_date === "string"
    ? req.body.business_date : new Date().toISOString().slice(0, 10);
  const actualCash = Number(req.body?.actual_cash);
  if (!Number.isFinite(actualCash) || actualCash < 0) {
    return res.status(400).json({ ok: false, error: "Invalid actual cash" });
  }
  const result = await pool.query(
    `INSERT INTO daily_cash_closures (business_date, actual_cash, notes, closed_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_date) DO UPDATE SET
       actual_cash=EXCLUDED.actual_cash, notes=EXCLUDED.notes,
       closed_by=EXCLUDED.closed_by, updated_at=NOW()
     RETURNING *`,
    [date, actualCash, req.body.notes || null, req.user.id]
  );
  await writeLog(req, "CASH_CLOSED", "cash_closure", date, { actual_cash: actualCash });
  res.json({ ok: true, closure: result.rows[0] });
});

app.get("/api/dashboard", requireSession, requirePermission("dashboard:view"), async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const conditions = [];
  const values = [];

  if (from) {
    values.push(from);
    conditions.push(`LEFT(i.invoice_date, 10) >= $${values.length}`);
  }
  if (to) {
    values.push(to);
    conditions.push(`LEFT(i.invoice_date, 10) <= $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    conditions.push(
      `(i.local_invoice_id::text ILIKE $${values.length}
        OR EXISTS (
          SELECT 1 FROM invoice_items search_item
          WHERE search_item.invoice_id = i.id
            AND search_item.product_name ILIKE $${values.length}
        ))`
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const [summary, invoices, dailySales, topProducts] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::integer AS invoice_count,
           COALESCE(SUM(i.invoice_total), 0)::numeric AS total_sales,
           COALESCE(AVG(i.invoice_total), 0)::numeric AS average_invoice,
           COALESCE(SUM((
             SELECT SUM(ii.quantity)
             FROM invoice_items ii
             WHERE ii.invoice_id = i.id
           )), 0)::integer AS items_sold
         FROM invoices i
         ${where}`,
        values
      ),
      pool.query(
        `SELECT
           i.local_invoice_id,
           i.invoice_date,
           i.invoice_total,
           i.created_at,
           COALESCE(SUM(ii.quantity), 0)::integer AS item_count
         FROM invoices i
         LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
         ${where}
         GROUP BY i.id
         ORDER BY i.id DESC
         LIMIT 5000`,
        values
      ),
      pool.query(
        `SELECT
           LEFT(i.invoice_date, 10) AS sale_date,
           COUNT(*)::integer AS invoice_count,
           SUM(i.invoice_total)::numeric AS total_sales
         FROM invoices i
         ${where}
         GROUP BY LEFT(i.invoice_date, 10)
         ORDER BY sale_date DESC
         LIMIT 14`,
        values
      ),
      pool.query(
        `SELECT
           ii.product_name,
           SUM(ii.quantity)::integer AS quantity,
           SUM(ii.quantity * ii.unit_price)::numeric AS total_sales
         FROM invoices i
         JOIN invoice_items ii ON ii.invoice_id = i.id
         ${where}
         GROUP BY ii.product_name
         ORDER BY quantity DESC, total_sales DESC
         LIMIT 8`,
        values
      )
    ]);

    res.json({
      ok: true,
      summary: summary.rows[0],
      invoices: invoices.rows,
      daily_sales: dailySales.rows.reverse(),
      top_products: topProducts.rows
    });
  } catch (error) {
    console.error("Dashboard query failed", error);
    res.status(500).json({ ok: false, error: "Could not load dashboard" });
  }
});

app.get("/api/invoices/:invoiceId", requireSession, requirePermission("invoices:view"), async (req, res) => {
  const invoiceId = Number(req.params.invoiceId);
  if (!Number.isInteger(invoiceId)) {
    return res.status(400).json({ ok: false, error: "Invalid invoice ID" });
  }

  try {
    const [invoice, items] = await Promise.all([
      pool.query(
        `SELECT local_invoice_id, invoice_date, invoice_total, created_at
         FROM invoices
         WHERE local_invoice_id = $1`,
        [invoiceId]
      ),
      pool.query(
        `SELECT ii.product_name, ii.quantity, ii.unit_price,
                (ii.quantity * ii.unit_price)::numeric AS line_total
         FROM invoice_items ii
         JOIN invoices i ON i.id = ii.invoice_id
         WHERE i.local_invoice_id = $1
         ORDER BY ii.id`,
        [invoiceId]
      )
    ]);

    if (invoice.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Invoice not found" });
    }

    res.json({ ok: true, invoice: invoice.rows[0], items: items.rows });
  } catch (error) {
    console.error("Invoice detail query failed", error);
    res.status(500).json({ ok: false, error: "Could not load invoice" });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError) {
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }
  console.error(error);
  res.status(500).json({ ok: false, error: "Internal server error" });
});

ensureSchema()
  .then(() => {
    app.listen(port, "0.0.0.0", () => {
      console.log(`Sales System API listening on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed", error);
    process.exitCode = 1;
  });
