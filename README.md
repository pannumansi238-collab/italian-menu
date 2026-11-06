# Osteria Rosso

The site and its Node.js backend run from the same origin. SQLite stores orders, rewards, and statuses in `data/osteria.sqlite`; the server validates menu items and calculates prices and GST.

## Run locally

1. Install Node.js 22.13 or later (for the built-in SQLite module; Node may display its SQLite experimental-feature warning).
2. In a terminal opened in this folder, run `npm start`.
3. Open <http://localhost:3000>.
4. Open **Staff** and enter `4040` to try the dashboard.

The first run creates `data/osteria.sqlite`. Stop the server before backing up the database file. Use **Load demo data** and **Clear all orders** from the staff sales tab to try the dashboard.

## Configure staff access

The code `4040` is for local development only. Set a different four-digit code before exposing the server to anyone else. In PowerShell:

```powershell
$env:STAFF_CODE = "your-new-four-digit-code"
npm start
```

In production, configure `STAFF_CODE`, `PORT`, and a persistent writable data directory (`DATA_DIR`) in your hosting provider. Staff sign-ins are rate-limited; staff sessions expire after 12 hours or when the server restarts. Put the server behind HTTPS before accepting real customer details. The current demo accepts orders without online payment.

## Orders and customer access

Orders are shared with the staff dashboard across devices using the same running server. Customers can see orders associated with their browser's saved customer-session token. Browser local storage is not a customer account or a cross-device sign-in; proper customer accounts and order recovery would need authentication.

No npm packages or separate database service are required. Existing `data/orders.json` data from the earlier prototype is imported into SQLite on first startup. Orders remain in the database when the server stops.
