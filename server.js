const express = require("express");
const { Pool } = require("pg");
const path = require("path");

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
app.use(express.static(path.join(__dirname, "public")));

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

app.get("/api/dashboard", requireApiKey, async (req, res) => {
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
         LIMIT 200`,
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

app.get("/api/invoices/:invoiceId", requireApiKey, async (req, res) => {
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

app.listen(port, "0.0.0.0", () => {
  console.log(`Sales System API listening on port ${port}`);
});
