# Sales System API

Render-hosted API for receiving offline invoice sync events from the desktop
SalesSystem application.

## Required Render environment variables

- `API_KEY`: A long random secret shared with the desktop app.
- `DATABASE_URL`: The PostgreSQL connection string from Supabase.

## Database setup

Run `schema.sql` once in the Supabase SQL Editor before sending invoices.

## Endpoints

- `GET /api/ping.php`
- `POST /api/sync_push.php`
- `GET /api/dashboard`

Protected endpoints require the `X-Api-Key` header.
