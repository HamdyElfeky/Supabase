const express = require("express");
const { Pool } = require("pg");

const app = express();
const port = Number(process.env.PORT || 10000);
const apiKey = process.env.API_KEY;
const databaseUrl = process.env.DATABASE_URL;

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

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

function requireApiKey(req, res, next) {
  if (req.get("X-Api-Key") !== apiKey) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
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

app.get("/api/dashboard", requireApiKey, async (_req, res) => {
  try {
    const [summary, invoices] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::integer AS invoice_count,
           COALESCE(SUM(invoice_total), 0)::numeric AS total_sales
         FROM invoices`
      ),
      pool.query(
        `SELECT local_invoice_id, invoice_date, invoice_total, created_at
         FROM invoices
         ORDER BY id DESC
         LIMIT 100`
      )
    ]);

    res.json({
      ok: true,
      summary: summary.rows[0],
      invoices: invoices.rows
    });
  } catch (error) {
    console.error("Dashboard query failed", error);
    res.status(500).json({ ok: false, error: "Could not load dashboard" });
  }
});

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sales System API</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #f5f7fa; color: #17202a; }
    main { max-width: 720px; margin: 12vh auto; padding: 32px; }
    h1 { font-size: 32px; margin: 0 0 12px; }
    p { color: #52606d; line-height: 1.6; }
    strong { color: #138a52; }
  </style>
</head>
<body>
  <main>
    <h1>Sales System API</h1>
    <p><strong>Service is running.</strong></p>
    <p>The desktop application can send queued invoices to this server.</p>
  </main>
</body>
</html>`);
});

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError) {
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }
  console.error(error);
  res.status(500).json({ ok: false, error: "Internal server error" });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Sales System API listening on port ${port}`);
});
