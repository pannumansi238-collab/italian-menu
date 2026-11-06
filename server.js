"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const DATA_FILE = path.join(DATA_DIR, "osteria.sqlite");
const PORT = Number(process.env.PORT || 3000);
const STAFF_CODE = process.env.STAFF_CODE || "4040";
const STAFF_SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MENU = {
  bruschetta: ["Bruschetta al Pomodoro", 320],
  burrata: ["Burrata e Pomodori", 520],
  arancini: ["Arancini Siciliani", 390],
  caprese: ["Insalata Caprese", 440],
  margherita: ["Margherita D.O.P.", 590],
  diavola: ["Diavola", 690],
  quattro: ["Quattro Formaggi", 720],
  funghi: ["Bosco di Funghi", 680],
  carbonara: ["Spaghetti Carbonara", 620],
  pesto: ["Pesto alla Genovese", 560],
  ragu: ["Tagliatelle al Ragù", 690],
  ravioli: ["Ravioli di Ricotta", 610],
  osso: ["Osso Buco Milanese", 1150],
  parmigiana: ["Melanzane alla Parmigiana", 720],
  pollo: ["Pollo al Limone", 890],
  tiramisu: ["Tiramisù della Casa", 360],
  panna: ["Panna Cotta", 320],
  cannoli: ["Cannoli Siciliani", 340],
  espresso: ["Espresso Romano", 180],
  spritz: ["Aperol Spritz", 420]
};
const REWARDS = [
  { title: "Free Espresso", icon: "E", weight: 34, min: 0, color: "#65422d" },
  { title: "Free Garlic Bread", icon: "✦", weight: 24, min: 0, color: "#aa6335" },
  { title: "10% Off Next Visit", icon: "10%", weight: 19, min: 0, color: "#a92822" },
  { title: "Free Cappuccino", icon: "C", weight: 20, min: 600, color: "#7a533a" },
  { title: "Free Tomato Basil Soup", icon: "✿", weight: 17, min: 900, color: "#9b392b" },
  { title: "Free Starter of the Day", icon: "★", weight: 15, min: 1200, color: "#7e5731" },
  { title: "20% Off Next Visit", icon: "20%", weight: 12, min: 1500, color: "#9f2724" },
  { title: "Free Mocktail", icon: "M", weight: 10, min: 1800, color: "#91422f" },
  { title: "Free Tiramisù", icon: "T", weight: 9, min: 2200, color: "#5a382b" },
  { title: "Chef’s Surprise Dish", icon: "!", weight: 6, min: 2800, color: "#68472d" }
];
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};
let orders = [];
let database;
const staffSessions = new Map();
const loginAttempts = new Map();

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function publicOrder(order) {
  const { customerTokenHash, ...safeOrder } = order;
  return safeOrder;
}

function isValidToken(token) {
  return typeof token === "string" && /^[a-f0-9]{64}$/i.test(token);
}

function chooseReward(subtotal) {
  const eligible = REWARDS.filter((reward) => subtotal >= reward.min);
  const weights = eligible.map(
    (reward) => reward.weight * Math.max(0.2, Math.min(1.8, 1 + (subtotal - reward.min) / 3500))
  );
  let choice = crypto.randomInt(0, 1000000) / 1000000 * weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < eligible.length; index += 1) {
    choice -= weights[index];
    if (choice <= 0) return eligible[index];
  }
  return eligible[0];
}

function makeReward(subtotal) {
  return {
    ...chooseReward(subtotal),
    code: `ROSSO-${crypto.randomBytes(2).toString("hex").toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
    revealed: false
  };
}

function persistOrder(order) {
  database.prepare(`
    INSERT INTO orders (id, created_at, status, customer_token_hash, order_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      created_at = excluded.created_at,
      status = excluded.status,
      customer_token_hash = excluded.customer_token_hash,
      order_json = excluded.order_json
  `).run(order.id, order.createdAt, order.status, order.customerTokenHash, JSON.stringify(order));
}

function persistAllOrders() {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DELETE FROM orders");
    for (const order of orders) persistOrder(order);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function requireStaff(request) {
  const authorization = request.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expiresAt = staffSessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    staffSessions.delete(token);
    return false;
  }
  staffSessions.set(token, Date.now() + STAFF_SESSION_MS);
  return true;
}

function loginIsLimited(ip) {
  const attempts = loginAttempts.get(ip);
  if (!attempts) return false;
  if (attempts.resetAt <= Date.now()) {
    loginAttempts.delete(ip);
    return false;
  }
  return attempts.count >= 5;
}

function recordFailedLogin(ip) {
  const current = loginAttempts.get(ip);
  if (!current || current.resetAt <= Date.now()) {
    loginAttempts.set(ip, { count: 1, resetAt: Date.now() + 15 * 60 * 1000 });
  } else {
    current.count += 1;
  }
}

async function handleApi(request, response, url) {
  const { pathname } = url;

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && pathname === "/api/staff/login") {
    const ip = request.socket.remoteAddress || "unknown";
    if (loginIsLimited(ip)) {
      sendJson(response, 429, { error: "Too many attempts. Please wait 15 minutes." });
      return;
    }
    const { code } = await readJson(request);
    if (typeof code !== "string" || code !== STAFF_CODE) {
      recordFailedLogin(ip);
      sendJson(response, 401, { error: "Invalid staff code." });
      return;
    }
    loginAttempts.delete(ip);
    const token = randomToken();
    staffSessions.set(token, Date.now() + STAFF_SESSION_MS);
    sendJson(response, 200, { token, expiresIn: STAFF_SESSION_MS });
    return;
  }

  if (request.method === "POST" && pathname === "/api/orders") {
    const body = await readJson(request);
    const customerToken = request.headers["x-customer-token"];
    const customer = typeof body.customer === "string" ? body.customer.trim() : "";
    const table = typeof body.table === "string" ? body.table.trim() : "";
    if (!customer || customer.length > 50 || !table || table.length > 12) {
      sendJson(response, 400, { error: "Enter a valid customer name and table number." });
      return;
    }
    if (!isValidToken(customerToken)) {
      sendJson(response, 400, { error: "A valid customer session is required." });
      return;
    }
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) {
      sendJson(response, 400, { error: "An order must contain between 1 and 20 dishes." });
      return;
    }
    const itemQuantities = new Map();
    for (const item of body.items) {
      if (!item || typeof item.id !== "string" || !MENU[item.id] ||
          !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 20) {
        sendJson(response, 400, { error: "The order contains an invalid menu item or quantity." });
        return;
      }
      itemQuantities.set(item.id, (itemQuantities.get(item.id) || 0) + item.qty);
    }
    const items = [...itemQuantities].map(([id, qty]) => ({
      id,
      name: MENU[id][0],
      price: MENU[id][1],
      qty
    }));
    const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
    const gst = Math.round(subtotal * 0.05);
    const order = {
      id: `OR-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
      createdAt: new Date().toISOString(),
      customer,
      table,
      items,
      subtotal,
      gst,
      total: subtotal + gst,
      status: "Received",
      reward: makeReward(subtotal),
      customerTokenHash: tokenHash(customerToken)
    };
    orders.unshift(order);
    persistOrder(order);
    sendJson(response, 201, { order: publicOrder(order) });
    return;
  }

  if (request.method === "GET" && pathname === "/api/orders") {
    const token = request.headers["x-customer-token"];
    if (!isValidToken(token)) {
      sendJson(response, 400, { error: "A valid customer session is required." });
      return;
    }
    const hash = tokenHash(token);
    sendJson(response, 200, {
      orders: orders.filter((order) => order.customerTokenHash === hash).map(publicOrder)
    });
    return;
  }

  const rewardMatch = pathname.match(/^\/api\/orders\/([^/]+)\/reward$/);
  if (request.method === "PATCH" && rewardMatch) {
    const customerToken = request.headers["x-customer-token"];
    if (!isValidToken(customerToken)) {
      sendJson(response, 401, { error: "Customer session is required." });
      return;
    }
    const order = orders.find((item) => item.id === decodeURIComponent(rewardMatch[1]));
    if (!order || order.customerTokenHash !== tokenHash(customerToken)) {
      sendJson(response, 404, { error: "Order not found." });
      return;
    }
    order.reward.revealed = true;
    persistOrder(order);
    sendJson(response, 200, { order: publicOrder(order) });
    return;
  }

  if (pathname.startsWith("/api/staff/") && !requireStaff(request)) {
    sendJson(response, 401, { error: "Staff sign-in required." });
    return;
  }

  if (request.method === "GET" && pathname === "/api/staff/orders") {
    sendJson(response, 200, { orders: orders.map(publicOrder) });
    return;
  }

  const statusMatch = pathname.match(/^\/api\/staff\/orders\/([^/]+)$/);
  if (request.method === "PATCH" && statusMatch) {
    const { status } = await readJson(request);
    const order = orders.find((item) => item.id === decodeURIComponent(statusMatch[1]));
    if (!order) {
      sendJson(response, 404, { error: "Order not found." });
      return;
    }
    if (!((order.status === "Received" && status === "Preparing") ||
          (order.status === "Preparing" && status === "Ready"))) {
      sendJson(response, 409, { error: "That order status transition is not allowed." });
      return;
    }
    order.status = status;
    persistOrder(order);
    sendJson(response, 200, { order: publicOrder(order) });
    return;
  }

  if (request.method === "DELETE" && pathname === "/api/staff/orders") {
    orders = [];
    database.exec("DELETE FROM orders");
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && pathname === "/api/staff/demo") {
    orders = orders.filter((order) => !order.id.startsWith("DEMO-"));
    const samples = [
      ["margherita", 2], ["ragu", 1], ["tiramisu", 1], ["bruschetta", 3],
      ["pesto", 1], ["osso", 1], ["diavola", 2]
    ];
    const names = ["Asha", "Marco", "Leela", "Rohan", "Maya", "Arjun", "Nina"];
    const now = Date.now();
    for (let day = 6; day >= 0; day -= 1) {
      const count = 1 + (day % 3);
      for (let index = 0; index < count; index += 1) {
        const [menuId, qty] = samples[(day + index) % samples.length];
        const [name, price] = MENU[menuId];
        const subtotal = price * qty;
        const gst = Math.round(subtotal * 0.05);
        const createdAt = new Date(now - day * 86400000 - (index + 2) * 3600000);
        orders.push({
          id: `DEMO-${day}-${index}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
          createdAt: createdAt.toISOString(),
          customer: names[(day + index) % names.length],
          table: String(1 + ((day + index) % 12)).padStart(2, "0"),
          items: [{ id: menuId, name, price, qty }],
          subtotal,
          gst,
          total: subtotal + gst,
          status: day === 0 ? "Received" : "Ready",
          reward: makeReward(subtotal),
          customerTokenHash: null
        });
      }
    }
    persistAllOrders();
    sendJson(response, 201, { orders: orders.map(publicOrder) });
    return;
  }

  sendJson(response, 404, { error: "API endpoint not found." });
}

async function serveFile(request, response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: "Invalid URL path." });
    return;
  }
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^[/\\]+/, "");
  if (!["index.html", "owner.jpg"].includes(relativePath)) {
    sendJson(response, 404, { error: "File not found." });
    return;
  }
  const resolvedPath = path.resolve(ROOT, relativePath);
  if (!resolvedPath.startsWith(`${ROOT}${path.sep}`) && resolvedPath !== ROOT) {
    sendJson(response, 403, { error: "Forbidden." });
    return;
  }
  try {
    const file = await fs.readFile(resolvedPath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(resolvedPath).toLowerCase()] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": path.basename(resolvedPath) === "index.html" ? "no-cache" : "public, max-age=3600"
    });
    response.end(request.method === "HEAD" ? undefined : file);
  } catch (error) {
    sendJson(response, error.code === "ENOENT" ? 404 : 500, {
      error: error.code === "ENOENT" ? "File not found." : "Could not read the requested file."
    });
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (url.pathname.startsWith("/api/")) {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Customer-Token",
        "Access-Control-Max-Age": "600"
      });
      response.end();
      return;
    }
    await handleApi(request, response, url);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }
  await serveFile(request, response, url.pathname);
}

async function main() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    database = new DatabaseSync(DATA_FILE);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        customer_token_hash TEXT,
        order_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at);
      CREATE INDEX IF NOT EXISTS orders_customer_token_idx ON orders(customer_token_hash);
    `);
    const savedOrderCount = database.prepare("SELECT COUNT(*) AS count FROM orders").get().count;
    if (savedOrderCount === 0) {
      const legacyFile = path.join(DATA_DIR, "orders.json");
      const legacyData = await fs.readFile(legacyFile, "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (legacyData !== null) {
        const legacyOrders = JSON.parse(legacyData);
        if (!Array.isArray(legacyOrders)) throw new Error("The legacy orders file must contain a JSON array.");
        orders = legacyOrders;
        persistAllOrders();
        console.log(`Migrated ${orders.length} saved orders into SQLite.`);
      }
    }
    orders = database.prepare("SELECT order_json FROM orders ORDER BY created_at DESC").all()
      .map((row) => JSON.parse(row.order_json));
  } catch (error) {
    console.error("Could not load persisted orders:", error);
    process.exitCode = 1;
    return;
  }

  if (!process.env.STAFF_CODE) {
    console.warn("Using development staff code 4040. Set STAFF_CODE before exposing this server publicly.");
  }
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error(`${request.method} ${request.url}:`, error);
      if (!response.headersSent) {
        sendJson(response, error.statusCode || 500, {
          error: error.statusCode ? error.message : "The server could not complete the request."
        });
      } else {
        response.destroy();
      }
    });
  });
  server.listen(PORT, () => {
    console.log(`Osteria Rosso is ready at http://localhost:${PORT}`);
    console.log(`SQLite database: ${DATA_FILE}`);
  });
}

main();
