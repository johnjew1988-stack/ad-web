const path = require("path");
const fs = require("fs");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const Stripe = require("stripe");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 3000;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY || "";
const adminApiToken = process.env.ADMIN_API_TOKEN || "";
const stripeClient = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const dbPath = path.join(dataDir, "adtech_users.db");
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const seededProducts = [
  {
    id: "pkg-basic",
    name: "Basic Package",
    description: "Essential system setup for small businesses. Includes core module implementation, basic integrations, and 3 months support.",
    price: 1500,
    currency: "USD",
    category: "Service Packages",
    sortOrder: 1
  },
  {
    id: "pkg-advance",
    name: "Advance Package",
    description: "Full-featured solution for growing businesses. Includes multi-module setup, custom workflows, API integrations, and 6 months support.",
    price: 4500,
    currency: "USD",
    category: "Service Packages",
    sortOrder: 2
  },
  {
    id: "pkg-premium",
    name: "Premium Package",
    description: "Enterprise-grade end-to-end system. Includes full customization, unlimited integrations, dedicated support team, and 12 months SLA.",
    price: 9500,
    currency: "USD",
    category: "Service Packages",
    sortOrder: 3
  }
];

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath, (error) => {
  if (error) {
    console.error("Failed to open database:", error.message);
  }
});

db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS registered_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      company TEXT NOT NULL,
      industry TEXT NOT NULL,
      challenge TEXT,
      registered_at TEXT NOT NULL
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS payment_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_intent_id TEXT NOT NULL UNIQUE,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      items_json TEXT NOT NULL,
      total_amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'card',
      created_at TEXT NOT NULL,
      paid_at TEXT,
      updated_at TEXT NOT NULL
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT NOT NULL UNIQUE,
      payment_intent_id TEXT NOT NULL UNIQUE,
      order_id INTEGER,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      items_json TEXT NOT NULL,
      subtotal_amount INTEGER NOT NULL,
      tax_amount INTEGER NOT NULL DEFAULT 0,
      total_amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'card',
      issued_at TEXT NOT NULL,
      paid_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(order_id) REFERENCES payment_orders(id)
    )`
  );

  db.run(`ALTER TABLE payment_orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'card'`, (error) => {
    if (error && !error.message.includes("duplicate column name")) {
      console.error("Failed to ensure payment order payment_method column:", error.message);
    }
  });

  db.run(`ALTER TABLE invoices ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'card'`, (error) => {
    if (error && !error.message.includes("duplicate column name")) {
      console.error("Failed to ensure invoice payment_method column:", error.message);
    }
  });

  db.run(
    `CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      price INTEGER NOT NULL,
      currency TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS finance_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      amount INTEGER NOT NULL,
      entry_date TEXT NOT NULL,
      reference TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_number TEXT NOT NULL UNIQUE,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      items_json TEXT NOT NULL,
      total_amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'draft',
      notes TEXT,
      valid_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  );

  db.run(`ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT 'General'`, (error) => {
    if (error && !error.message.includes("duplicate column name")) {
      console.error("Failed to ensure product category column:", error.message);
    }
  });

  const upsertProductStmt = db.prepare(
    `INSERT INTO products (id, name, description, price, currency, category, active, sort_order, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       price = excluded.price,
       currency = excluded.currency,
       category = excluded.category,
       active = excluded.active,
       sort_order = excluded.sort_order,
       updated_at = excluded.updated_at`
  );

  const seededAt = new Date().toISOString();
  seededProducts.forEach((product) => {
    upsertProductStmt.run([
      product.id,
      product.name,
      product.description,
      product.price,
      product.currency,
      product.category,
      product.sortOrder,
      seededAt
    ]);
  });
  upsertProductStmt.finalize();
});

const runQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }

      resolve(this);
    });
  });

const allQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows);
    });
  });

const getQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row);
    });
  });

const mapProductRow = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  price: row.price,
  currency: row.currency,
  category: row.category,
  active: Boolean(row.active),
  sortOrder: row.sort_order
});

const mapFinanceEntryRow = (row) => ({
  id: row.id,
  scope: row.scope,
  entryType: row.entry_type,
  category: row.category,
  description: row.description,
  amount: row.amount,
  entryDate: row.entry_date,
  reference: row.reference,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const parseJsonArray = (value) => {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
};

const mapInvoiceRow = (row) => ({
  id: row.id,
  invoiceNumber: row.invoice_number,
  paymentIntentId: row.payment_intent_id,
  orderId: row.order_id,
  customerName: row.customer_name,
  customerEmail: row.customer_email,
  items: parseJsonArray(row.items_json),
  subtotalAmount: row.subtotal_amount,
  taxAmount: row.tax_amount,
  totalAmount: row.total_amount,
  currency: row.currency,
  status: row.status,
  paymentMethod: row.payment_method || "card",
  issuedAt: row.issued_at,
  paidAt: row.paid_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const supportedPaymentMethods = new Set(["card", "cash", "bank_transfer"]);

const normalizePaymentMethod = (value, defaultValue = "card") => {
  const method = String(value || defaultValue)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  return supportedPaymentMethods.has(method) ? method : defaultValue;
};

const createInvoiceNumber = ({ orderId, issuedAt }) => {
  const date = new Date(issuedAt || Date.now());
  const dayPart = date.toISOString().slice(0, 10).replace(/-/g, "");
  const timePart = date.toISOString().slice(11, 19).replace(/:/g, "");
  const orderPart = String(Number.parseInt(orderId, 10) || 0).padStart(6, "0");
  return `INV-${dayPart}-${timePart}-${orderPart}`;
};

const buildInvoiceSummary = (invoices) => {
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const summary = {
    invoicesCount: invoices.length,
    paidInvoicesCount: 0,
    totalRevenue: 0,
    monthlyRevenue: 0,
    outstandingRevenue: 0
  };

  invoices.forEach((invoice) => {
    if (invoice.status === "paid") {
      summary.paidInvoicesCount += 1;
      summary.totalRevenue += invoice.totalAmount;

      if (String(invoice.paidAt || "").startsWith(monthPrefix)) {
        summary.monthlyRevenue += invoice.totalAmount;
      }
    } else {
      summary.outstandingRevenue += invoice.totalAmount;
    }
  });

  return summary;
};

const financeScopes = new Set(["accounting", "financing"]);
const financeEntryTypes = new Set(["income", "expense"]);

const normalizeProductId = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const validateProductPayload = ({ id, name, description, price, category, active, sortOrder }, { requireId = false } = {}) => {
  const normalizedId = normalizeProductId(id);
  const trimmedName = typeof name === "string" ? name.trim() : "";
  const trimmedDescription = typeof description === "string" ? description.trim() : "";
  const trimmedCategory = typeof category === "string" ? category.trim() : "General";
  const numericPrice = Number.parseInt(price, 10);
  const normalizedActive = active === undefined ? 1 : active ? 1 : 0;
  const normalizedSortOrder = sortOrder === undefined ? 0 : Number.parseInt(sortOrder, 10);

  if (requireId && (!normalizedId || normalizedId.length < 3)) {
    return { error: "Product id must be at least 3 characters and use letters, numbers, or hyphens." };
  }

  if (!trimmedName || trimmedName.length < 3) {
    return { error: "Product name must be at least 3 characters." };
  }

  if (!trimmedDescription || trimmedDescription.length < 10) {
    return { error: "Product description must be at least 10 characters." };
  }

  if (!trimmedCategory || trimmedCategory.length < 2) {
    return { error: "Category must be at least 2 characters." };
  }

  if (!Number.isInteger(numericPrice) || numericPrice < 1) {
    return { error: "Price must be a positive whole number." };
  }

  if (!Number.isInteger(normalizedSortOrder)) {
    return { error: "Sort order must be a whole number." };
  }

  return {
    value: {
      id: normalizedId,
      name: trimmedName,
      description: trimmedDescription,
      price: numericPrice,
      category: trimmedCategory,
      active: normalizedActive,
      sortOrder: normalizedSortOrder
    }
  };
};

const validateFinanceEntryPayload = ({ scope, entryType, category, description, amount, entryDate, reference }) => {
  const normalizedScope = typeof scope === "string" ? scope.trim().toLowerCase() : "";
  const normalizedEntryType = typeof entryType === "string" ? entryType.trim().toLowerCase() : "";
  const trimmedCategory = typeof category === "string" ? category.trim() : "";
  const trimmedDescription = typeof description === "string" ? description.trim() : "";
  const numericAmount = Number.parseInt(amount, 10);
  const normalizedEntryDate = typeof entryDate === "string" ? entryDate.trim() : "";
  const trimmedReference = typeof reference === "string" ? reference.trim() : "";

  if (!financeScopes.has(normalizedScope)) {
    return { error: "Scope must be accounting or financing." };
  }

  if (!financeEntryTypes.has(normalizedEntryType)) {
    return { error: "Entry type must be income or expense." };
  }

  if (!trimmedCategory || trimmedCategory.length < 2) {
    return { error: "Category must be at least 2 characters." };
  }

  if (!Number.isInteger(numericAmount) || numericAmount < 1) {
    return { error: "Amount must be a positive whole number." };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedEntryDate)) {
    return { error: "Entry date must use YYYY-MM-DD format." };
  }

  return {
    value: {
      scope: normalizedScope,
      entryType: normalizedEntryType,
      category: trimmedCategory,
      description: trimmedDescription,
      amount: numericAmount,
      entryDate: normalizedEntryDate,
      reference: trimmedReference
    }
  };
};

const requireAdminAccess = (req, res, next) => {
  if (!adminApiToken) {
    next();
    return;
  }

  const providedToken = req.get("x-admin-token") || "";

  if (providedToken !== adminApiToken) {
    res.status(401).json({ error: "Unauthorized admin request." });
    return;
  }

  next();
};

const fetchActiveProducts = async () => {
  const rows = await allQuery(
    `SELECT id, name, description, price, currency, category
     FROM products
     WHERE active = 1
     ORDER BY sort_order ASC, name ASC`
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    price: row.price,
    currency: row.currency,
    category: row.category
  }));
};

const fetchAllProducts = async () => {
  const rows = await allQuery(
    `SELECT id, name, description, price, currency, category, active, sort_order
     FROM products
     ORDER BY sort_order ASC, name ASC`
  );

  return rows.map(mapProductRow);
};

const fetchFinanceEntries = async (scope = "all") => {
  const normalizedScope = financeScopes.has(scope) ? scope : "all";
  const params = [];
  let sql = `SELECT id, scope, entry_type, category, description, amount, entry_date, reference, created_at, updated_at
             FROM finance_entries`;

  if (normalizedScope !== "all") {
    sql += " WHERE scope = ?";
    params.push(normalizedScope);
  }

  sql += " ORDER BY entry_date DESC, id DESC";
  const rows = await allQuery(sql, params);
  return rows.map(mapFinanceEntryRow);
};

const buildFinanceSummary = (entries) => {
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const totals = {
    totalIncome: 0,
    totalExpense: 0,
    netCashflow: 0,
    entriesCount: entries.length,
    monthlyIncome: 0,
    monthlyExpense: 0,
    monthlyNet: 0,
    accountingNet: 0,
    financingNet: 0
  };

  entries.forEach((entry) => {
    const isIncome = entry.entryType === "income";
    const signedAmount = isIncome ? entry.amount : -entry.amount;

    if (isIncome) {
      totals.totalIncome += entry.amount;
    } else {
      totals.totalExpense += entry.amount;
    }

    totals.netCashflow += signedAmount;

    if (entry.entryDate.startsWith(monthPrefix)) {
      if (isIncome) {
        totals.monthlyIncome += entry.amount;
      } else {
        totals.monthlyExpense += entry.amount;
      }
    }

    if (entry.scope === "accounting") {
      totals.accountingNet += signedAmount;
    }

    if (entry.scope === "financing") {
      totals.financingNet += signedAmount;
    }
  });

  totals.monthlyNet = totals.monthlyIncome - totals.monthlyExpense;
  return totals;
};

const normalizeOrderItems = async (items) => {
  if (!Array.isArray(items) || !items.length) {
    throw new Error("Your cart is empty.");
  }

  const requestedIds = [...new Set(items.map((item) => item?.id).filter(Boolean))];

  if (!requestedIds.length) {
    throw new Error("Your cart is empty.");
  }

  const placeholders = requestedIds.map(() => "?").join(", ");
  const products = await allQuery(
    `SELECT id, name, description, price, currency, category
     FROM products
     WHERE active = 1 AND id IN (${placeholders})`,
    requestedIds
  );
  const productMap = new Map(products.map((product) => [product.id, product]));

  return items.map((item) => {
    const product = productMap.get(item?.id);
    const quantity = Number.parseInt(item?.quantity, 10);

    if (!product) {
      throw new Error("Your cart contains an unavailable item.");
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 25) {
      throw new Error(`Invalid quantity for ${product.name}.`);
    }

    return {
      id: product.id,
      name: product.name,
      unitPrice: product.price,
      quantity,
      lineTotal: product.price * quantity
    };
  });
};

app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const isLocalhostOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);

  if (origin === "null" || isLocalhostOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-admin-token");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
});

app.use(express.json());
app.use(express.static(__dirname));

app.get("/api/products", async (req, res) => {
  try {
    const products = await fetchActiveProducts();
    return res.json({ products });
  } catch (error) {
    console.error("Failed to fetch products:", error?.message || error);
    return res.status(500).json({ error: "Could not fetch products." });
  }
});

app.get("/api/admin/products", requireAdminAccess, async (req, res) => {
  try {
    const products = await fetchAllProducts();
    return res.json({
      products,
      authRequired: Boolean(adminApiToken)
    });
  } catch (error) {
    console.error("Failed to fetch admin products:", error?.message || error);
    return res.status(500).json({ error: "Could not fetch products." });
  }
});

app.post("/api/admin/products", requireAdminAccess, async (req, res) => {
  try {
    const validation = validateProductPayload(req.body || {}, { requireId: true });

    if (validation.error) {
      return res.status(400).json({ error: validation.error });
    }

    const { id, name, description, price, category, active, sortOrder } = validation.value;
    const existingProduct = await getQuery(`SELECT id FROM products WHERE id = ?`, [id]);

    if (existingProduct) {
      return res.status(409).json({ error: "A product with that id already exists." });
    }

    const updatedAt = new Date().toISOString();
    await runQuery(
      `INSERT INTO products (id, name, description, price, currency, category, active, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, description, price, "USD", category, active, sortOrder, updatedAt]
    );

    const createdProduct = await getQuery(
      `SELECT id, name, description, price, currency, category, active, sort_order
       FROM products
       WHERE id = ?`,
      [id]
    );

    return res.status(201).json({ product: mapProductRow(createdProduct) });
  } catch (error) {
    console.error("Failed to create product:", error?.message || error);
    return res.status(500).json({ error: "Could not create product." });
  }
});

app.put("/api/admin/products/:id", requireAdminAccess, async (req, res) => {
  try {
    const productId = req.params.id;
    const validation = validateProductPayload(req.body || {});

    if (validation.error) {
      return res.status(400).json({ error: validation.error });
    }

    const { name, description, price, category, active, sortOrder } = validation.value;

    const existingProduct = await getQuery(
      `SELECT id, currency FROM products WHERE id = ?`,
      [productId]
    );

    if (!existingProduct) {
      return res.status(404).json({ error: "Product not found." });
    }

    const updatedAt = new Date().toISOString();
    await runQuery(
      `UPDATE products
       SET name = ?, description = ?, price = ?, category = ?, active = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`,
      [name, description, price, category, active, sortOrder, updatedAt, productId]
    );

    const updatedProduct = await getQuery(
      `SELECT id, name, description, price, currency, category, active, sort_order
       FROM products
       WHERE id = ?`,
      [productId]
    );

    return res.json({ product: mapProductRow(updatedProduct) });
  } catch (error) {
    console.error("Failed to update product:", error?.message || error);
    return res.status(500).json({ error: "Could not update product." });
  }
});

app.delete("/api/admin/products/:id", requireAdminAccess, async (req, res) => {
  try {
    const productId = req.params.id;
    const existingProduct = await getQuery(`SELECT id FROM products WHERE id = ?`, [productId]);

    if (!existingProduct) {
      return res.status(404).json({ error: "Product not found." });
    }

    await runQuery(`DELETE FROM products WHERE id = ?`, [productId]);
    return res.json({ message: "Product deleted." });
  } catch (error) {
    console.error("Failed to delete product:", error?.message || error);
    return res.status(500).json({ error: "Could not delete product." });
  }
});

app.get("/api/admin/finance/entries", requireAdminAccess, async (req, res) => {
  try {
    const requestedScope = typeof req.query.scope === "string" ? req.query.scope.trim().toLowerCase() : "all";
    const scope = financeScopes.has(requestedScope) ? requestedScope : "all";
    const entries = await fetchFinanceEntries(scope);
    return res.json({ entries, scope });
  } catch (error) {
    console.error("Failed to fetch finance entries:", error?.message || error);
    return res.status(500).json({ error: "Could not fetch finance entries." });
  }
});

app.get("/api/admin/finance/summary", requireAdminAccess, async (req, res) => {
  try {
    const requestedScope = typeof req.query.scope === "string" ? req.query.scope.trim().toLowerCase() : "all";
    const scope = financeScopes.has(requestedScope) ? requestedScope : "all";
    const entries = await fetchFinanceEntries(scope);
    const summary = buildFinanceSummary(entries);
    return res.json({ summary, scope });
  } catch (error) {
    console.error("Failed to fetch finance summary:", error?.message || error);
    return res.status(500).json({ error: "Could not fetch finance summary." });
  }
});

app.get("/api/admin/accounting/invoices", requireAdminAccess, async (req, res) => {
  try {
    const limitRaw = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 200;
    const statusFilter = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "";
    const methodFilter = typeof req.query.payment_method === "string" ? req.query.payment_method.trim().toLowerCase() : "";
    const fromDate = typeof req.query.from === "string" ? req.query.from.trim() : "";
    const toDate = typeof req.query.to === "string" ? req.query.to.trim() : "";

    const params = [];
    const conditions = [];
    let sql = `SELECT
      id,
      invoice_number,
      payment_intent_id,
      order_id,
      customer_name,
      customer_email,
      items_json,
      subtotal_amount,
      tax_amount,
      total_amount,
      currency,
      status,
      payment_method,
      issued_at,
      paid_at,
      created_at,
      updated_at
     FROM invoices`;

    if (statusFilter) {
      conditions.push("status = ?");
      params.push(statusFilter);
    }

    if (methodFilter && supportedPaymentMethods.has(methodFilter)) {
      conditions.push("payment_method = ?");
      params.push(methodFilter);
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
      conditions.push("substr(issued_at, 1, 10) >= ?");
      params.push(fromDate);
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
      conditions.push("substr(issued_at, 1, 10) <= ?");
      params.push(toDate);
    }

    if (conditions.length) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }

    sql += " ORDER BY issued_at DESC, id DESC LIMIT ?";
    params.push(limit);

    const rows = await allQuery(sql, params);
    const invoices = rows.map(mapInvoiceRow);
    return res.json({ invoices, limit });
  } catch (error) {
    console.error("Failed to fetch accounting invoices:", error?.message || error);
    return res.status(500).json({ error: "Could not fetch accounting invoices." });
  }
});

app.get("/api/admin/accounting/invoices/summary", requireAdminAccess, async (_req, res) => {
  try {
    const rows = await allQuery(
      `SELECT
        id,
        invoice_number,
        payment_intent_id,
        order_id,
        customer_name,
        customer_email,
        items_json,
        subtotal_amount,
        tax_amount,
        total_amount,
        currency,
        status,
        payment_method,
        issued_at,
        paid_at,
        created_at,
        updated_at
       FROM invoices
       ORDER BY issued_at DESC, id DESC`
    );
    const invoices = rows.map(mapInvoiceRow);
    const summary = buildInvoiceSummary(invoices);
    return res.json({ summary });
  } catch (error) {
    console.error("Failed to build invoice summary:", error?.message || error);
    return res.status(500).json({ error: "Could not build invoice summary." });
  }
});

app.patch("/api/admin/accounting/invoices/:id/paid", requireAdminAccess, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "Invalid invoice ID." });
    }
    const existing = await getQuery("SELECT id, status FROM invoices WHERE id = ?", [id]);
    if (!existing) {
      return res.status(404).json({ error: "Invoice not found." });
    }
    if (existing.status === "paid") {
      return res.status(409).json({ error: "Invoice is already marked as paid." });
    }
    const now = new Date().toISOString();
    await runQuery(
      "UPDATE invoices SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?",
      [now, now, id]
    );
    const updated = await getQuery("SELECT * FROM invoices WHERE id = ?", [id]);
    return res.json({ message: "Invoice marked as paid.", invoice: mapInvoiceRow(updated) });
  } catch (error) {
    console.error("Failed to mark invoice as paid:", error?.message || error);
    return res.status(500).json({ error: "Could not update invoice." });
  }
});

app.post("/api/admin/finance/entries", requireAdminAccess, async (req, res) => {
  try {
    const validation = validateFinanceEntryPayload(req.body || {});

    if (validation.error) {
      return res.status(400).json({ error: validation.error });
    }

    const { scope, entryType, category, description, amount, entryDate, reference } = validation.value;
    const now = new Date().toISOString();
    const result = await runQuery(
      `INSERT INTO finance_entries (
        scope,
        entry_type,
        category,
        description,
        amount,
        entry_date,
        reference,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [scope, entryType, category, description, amount, entryDate, reference, now, now]
    );

    const createdEntry = await getQuery(
      `SELECT id, scope, entry_type, category, description, amount, entry_date, reference, created_at, updated_at
       FROM finance_entries
       WHERE id = ?`,
      [result.lastID]
    );

    return res.status(201).json({ entry: mapFinanceEntryRow(createdEntry) });
  } catch (error) {
    console.error("Failed to create finance entry:", error?.message || error);
    return res.status(500).json({ error: "Could not create finance entry." });
  }
});

app.put("/api/admin/finance/entries/:id", requireAdminAccess, async (req, res) => {
  try {
    const entryId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(entryId) || entryId < 1) {
      return res.status(400).json({ error: "Invalid entry id." });
    }

    const validation = validateFinanceEntryPayload(req.body || {});

    if (validation.error) {
      return res.status(400).json({ error: validation.error });
    }

    const existingEntry = await getQuery(`SELECT id FROM finance_entries WHERE id = ?`, [entryId]);

    if (!existingEntry) {
      return res.status(404).json({ error: "Finance entry not found." });
    }

    const { scope, entryType, category, description, amount, entryDate, reference } = validation.value;
    const now = new Date().toISOString();
    await runQuery(
      `UPDATE finance_entries
       SET scope = ?, entry_type = ?, category = ?, description = ?, amount = ?, entry_date = ?, reference = ?, updated_at = ?
       WHERE id = ?`,
      [scope, entryType, category, description, amount, entryDate, reference, now, entryId]
    );

    const updatedEntry = await getQuery(
      `SELECT id, scope, entry_type, category, description, amount, entry_date, reference, created_at, updated_at
       FROM finance_entries
       WHERE id = ?`,
      [entryId]
    );

    return res.json({ entry: mapFinanceEntryRow(updatedEntry) });
  } catch (error) {
    console.error("Failed to update finance entry:", error?.message || error);
    return res.status(500).json({ error: "Could not update finance entry." });
  }
});

app.delete("/api/admin/finance/entries/:id", requireAdminAccess, async (req, res) => {
  try {
    const entryId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(entryId) || entryId < 1) {
      return res.status(400).json({ error: "Invalid entry id." });
    }

    const existingEntry = await getQuery(`SELECT id FROM finance_entries WHERE id = ?`, [entryId]);

    if (!existingEntry) {
      return res.status(404).json({ error: "Finance entry not found." });
    }

    await runQuery(`DELETE FROM finance_entries WHERE id = ?`, [entryId]);
    return res.json({ message: "Finance entry deleted." });
  } catch (error) {
    console.error("Failed to delete finance entry:", error?.message || error);
    return res.status(500).json({ error: "Could not delete finance entry." });
  }
});

// ── Quotation helpers ──────────────────────────────────────────────────────

const createQuoteNumber = ({ id, createdAt }) => {
  const date = new Date(createdAt || Date.now());
  const day = date.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = String(Number.parseInt(id, 10) || 0).padStart(5, "0");
  return `QT-${day}-${seq}`;
};

const validQuoteStatuses = new Set(["draft", "sent", "accepted", "declined", "expired"]);

const mapQuotationRow = (row) => ({
  id: row.id,
  quoteNumber: row.quote_number,
  customerName: row.customer_name,
  customerEmail: row.customer_email,
  items: parseJsonArray(row.items_json),
  totalAmount: row.total_amount,
  currency: row.currency,
  status: row.status,
  notes: row.notes || "",
  validUntil: row.valid_until || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

// ── Quotation endpoints ────────────────────────────────────────────────────

app.get("/api/admin/quotations", requireAdminAccess, async (req, res) => {
  try {
    const statusFilter = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "";
    const params = [];
    let sql = `SELECT id, quote_number, customer_name, customer_email, items_json, total_amount, currency, status, notes, valid_until, created_at, updated_at
               FROM quotations`;
    if (statusFilter && validQuoteStatuses.has(statusFilter)) {
      sql += " WHERE status = ?";
      params.push(statusFilter);
    }
    sql += " ORDER BY created_at DESC, id DESC";
    const rows = await allQuery(sql, params);
    return res.json({ quotations: rows.map(mapQuotationRow) });
  } catch (error) {
    console.error("Failed to fetch quotations:", error?.message || error);
    return res.status(500).json({ error: "Could not fetch quotations." });
  }
});

app.post("/api/admin/quotations", requireAdminAccess, async (req, res) => {
  try {
    const { customerName, customerEmail, items, notes, validUntil } = req.body || {};

    const trimmedName = typeof customerName === "string" ? customerName.trim() : "";
    const trimmedEmail = typeof customerEmail === "string" ? customerEmail.trim().toLowerCase() : "";
    const trimmedNotes = typeof notes === "string" ? notes.trim() : "";
    const trimmedValidUntil = typeof validUntil === "string" && /^\d{4}-\d{2}-\d{2}$/.test(validUntil.trim()) ? validUntil.trim() : null;

    if (trimmedName.length < 2) return res.status(400).json({ error: "Customer name must be at least 2 characters." });
    if (!emailPattern.test(trimmedEmail)) return res.status(400).json({ error: "Invalid customer email address." });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Quotation must have at least one line item." });

    const lineItems = items.map((item) => {
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const qty = Number.parseInt(item.quantity, 10);
      const unitPrice = Number.parseInt(item.unitPrice, 10);
      if (!name) throw new Error("Each line item must have a name.");
      if (!Number.isInteger(qty) || qty < 1) throw new Error(`Invalid quantity for "${name}".`);
      if (!Number.isInteger(unitPrice) || unitPrice < 0) throw new Error(`Invalid unit price for "${name}".`);
      return { id: item.id || null, name, quantity: qty, unitPrice, lineTotal: unitPrice * qty };
    });

    const totalAmount = lineItems.reduce((s, i) => s + i.lineTotal, 0);
    const now = new Date().toISOString();

    const result = await runQuery(
      `INSERT INTO quotations (quote_number, customer_name, customer_email, items_json, total_amount, currency, status, notes, valid_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'USD', 'draft', ?, ?, ?, ?)`,
      ["QT-TEMP", trimmedName, trimmedEmail, JSON.stringify(lineItems), totalAmount, trimmedNotes, trimmedValidUntil, now, now]
    );

    const quoteNumber = createQuoteNumber({ id: result.lastID, createdAt: now });
    await runQuery(`UPDATE quotations SET quote_number = ? WHERE id = ?`, [quoteNumber, result.lastID]);

    const created = await getQuery(`SELECT * FROM quotations WHERE id = ?`, [result.lastID]);
    return res.status(201).json({ quotation: mapQuotationRow(created) });
  } catch (error) {
    console.error("Failed to create quotation:", error?.message || error);
    return res.status(error.message?.includes("must") ? 400 : 500).json({ error: error.message || "Could not create quotation." });
  }
});

app.put("/api/admin/quotations/:id/status", requireAdminAccess, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid quotation ID." });

    const newStatus = typeof req.body?.status === "string" ? req.body.status.trim().toLowerCase() : "";
    if (!validQuoteStatuses.has(newStatus)) return res.status(400).json({ error: "Invalid status. Use: draft, sent, accepted, declined, expired." });

    const existing = await getQuery("SELECT id FROM quotations WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ error: "Quotation not found." });

    const now = new Date().toISOString();
    await runQuery("UPDATE quotations SET status = ?, updated_at = ? WHERE id = ?", [newStatus, now, id]);
    const updated = await getQuery("SELECT * FROM quotations WHERE id = ?", [id]);
    return res.json({ quotation: mapQuotationRow(updated) });
  } catch (error) {
    console.error("Failed to update quotation status:", error?.message || error);
    return res.status(500).json({ error: "Could not update quotation." });
  }
});

app.delete("/api/admin/quotations/:id", requireAdminAccess, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid quotation ID." });

    const existing = await getQuery("SELECT id FROM quotations WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ error: "Quotation not found." });

    await runQuery("DELETE FROM quotations WHERE id = ?", [id]);
    return res.json({ message: "Quotation deleted." });
  } catch (error) {
    console.error("Failed to delete quotation:", error?.message || error);
    return res.status(500).json({ error: "Could not delete quotation." });
  }
});

app.get("/api/stripe-config", (req, res) => {
  return res.json({ publishableKey: stripePublishableKey });
});

app.post("/api/register", (req, res) => {
  const { fullName, email, company, industry, challenge } = req.body || {};

  if (!fullName || fullName.trim().length < 2) {
    return res.status(400).json({ error: "Full name must be at least 2 characters." });
  }

  if (!email || !emailPattern.test(email.trim())) {
    return res.status(400).json({ error: "Please provide a valid email." });
  }

  if (!company || company.trim().length < 2) {
    return res.status(400).json({ error: "Company name must be at least 2 characters." });
  }

  if (!industry || !industry.trim()) {
    return res.status(400).json({ error: "Industry is required." });
  }

  const stmt = `INSERT INTO registered_users (
      full_name,
      email,
      company,
      industry,
      challenge,
      registered_at
    ) VALUES (?, ?, ?, ?, ?, ?)`;

  db.run(
    stmt,
    [
      fullName.trim(),
      email.trim().toLowerCase(),
      company.trim(),
      industry.trim(),
      (challenge || "").trim(),
      new Date().toISOString()
    ],
    function onInsert(error) {
      if (error) {
        console.error("Failed to insert user:", error.message);
        return res.status(500).json({ error: "Could not save registration." });
      }

      return res.status(201).json({ message: "Registration saved.", userId: this.lastID });
    }
  );
});

app.post("/api/create-offline-order", async (req, res) => {
  try {
    const { customerName, customerEmail, items, paymentMethod } = req.body || {};
    const normalizedMethod = normalizePaymentMethod(paymentMethod, "");

    if (normalizedMethod !== "cash" && normalizedMethod !== "bank_transfer") {
      return res.status(400).json({ error: "Payment method must be cash or bank transfer." });
    }

    if (!customerName || customerName.trim().length < 2) {
      return res.status(400).json({ error: "Please enter your full name." });
    }

    if (!customerEmail || !emailPattern.test(customerEmail.trim())) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }

    const orderItems = await normalizeOrderItems(items);
    const total = orderItems.reduce((sum, item) => sum + item.lineTotal, 0);
    const now = new Date().toISOString();
    const offlinePaymentIntentId = `offline-${normalizedMethod}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    const orderInsert = await runQuery(
      `INSERT INTO payment_orders (
        payment_intent_id,
        customer_name,
        customer_email,
        items_json,
        total_amount,
        currency,
        status,
        payment_method,
        created_at,
        paid_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        offlinePaymentIntentId,
        customerName.trim(),
        customerEmail.trim().toLowerCase(),
        JSON.stringify(orderItems),
        total,
        "usd",
        "pending",
        normalizedMethod,
        now,
        null,
        now
      ]
    );

    const orderId = orderInsert.lastID;
    const invoiceNumber = createInvoiceNumber({ orderId, issuedAt: now });

    await runQuery(
      `INSERT INTO invoices (
        invoice_number,
        payment_intent_id,
        order_id,
        customer_name,
        customer_email,
        items_json,
        subtotal_amount,
        tax_amount,
        total_amount,
        currency,
        status,
        payment_method,
        issued_at,
        paid_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceNumber,
        offlinePaymentIntentId,
        orderId,
        customerName.trim(),
        customerEmail.trim().toLowerCase(),
        JSON.stringify(orderItems),
        total,
        0,
        total,
        "USD",
        "pending",
        normalizedMethod,
        now,
        null,
        now,
        now
      ]
    );

    const savedInvoice = await getQuery(
      `SELECT
        id,
        invoice_number,
        payment_intent_id,
        order_id,
        customer_name,
        customer_email,
        items_json,
        subtotal_amount,
        tax_amount,
        total_amount,
        currency,
        status,
        payment_method,
        issued_at,
        paid_at,
        created_at,
        updated_at
       FROM invoices
       WHERE payment_intent_id = ?`,
      [offlinePaymentIntentId]
    );

    const methodLabel = normalizedMethod === "cash" ? "cash" : "bank transfer";

    return res.status(201).json({
      message: `Order saved with ${methodLabel} payment method.`,
      invoice: savedInvoice ? mapInvoiceRow(savedInvoice) : null
    });
  } catch (error) {
    const message = error?.message || "Could not create offline order.";

    if (
      message === "Your cart is empty." ||
      message === "Your cart contains an unavailable item." ||
      message.startsWith("Invalid quantity for ")
    ) {
      return res.status(400).json({ error: message });
    }

    console.error("Failed to create offline order:", message);
    return res.status(500).json({ error: "Could not create offline order." });
  }
});

app.post("/api/create-payment-intent", async (req, res) => {
  try {
    if (!stripeClient || !stripePublishableKey) {
      return res.status(503).json({ error: "Card payments are not configured on the server." });
    }

    const { customerName, customerEmail, items } = req.body || {};

    if (!customerName || customerName.trim().length < 2) {
      return res.status(400).json({ error: "Please enter your full name." });
    }

    if (!customerEmail || !emailPattern.test(customerEmail.trim())) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }

    const orderItems = await normalizeOrderItems(items);
    const total = orderItems.reduce((sum, item) => sum + item.lineTotal, 0);
    const now = new Date().toISOString();
    const paymentIntent = await stripeClient.paymentIntents.create({
      amount: total * 100,
      currency: "usd",
      payment_method_types: ["card"],
      receipt_email: customerEmail.trim().toLowerCase(),
      metadata: {
        customerName: customerName.trim().slice(0, 60),
        customerEmail: customerEmail.trim().toLowerCase(),
        items: orderItems.map((item) => `${item.id}:${item.quantity}`).join(",")
      }
    });

    await runQuery(
      `INSERT INTO payment_orders (
        payment_intent_id,
        customer_name,
        customer_email,
        items_json,
        total_amount,
        currency,
        status,
        payment_method,
        created_at,
        paid_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        paymentIntent.id,
        customerName.trim(),
        customerEmail.trim().toLowerCase(),
        JSON.stringify(orderItems),
        total,
        "usd",
        "pending",
        "card",
        now,
        null,
        now
      ]
    );

    return res.status(201).json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    const message = error?.message || "Could not start card payment.";

    if (
      message === "Your cart is empty." ||
      message === "Your cart contains an unavailable item." ||
      message.startsWith("Invalid quantity for ")
    ) {
      return res.status(400).json({ error: message });
    }

    console.error("Failed to create payment intent:", message);
    return res.status(500).json({ error: "Could not start card payment." });
  }
});

app.post("/api/payment-success", async (req, res) => {
  try {
    if (!stripeClient) {
      return res.status(503).json({ error: "Card payments are not configured on the server." });
    }

    const { paymentIntentId } = req.body || {};

    if (!paymentIntentId || typeof paymentIntentId !== "string") {
      return res.status(400).json({ error: "Missing payment intent id." });
    }

    const paymentIntent = await stripeClient.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== "succeeded") {
      return res.status(409).json({ error: "Payment has not completed yet." });
    }

    const order = await getQuery(
      `SELECT id, payment_intent_id, customer_name, customer_email, items_json, total_amount, currency, payment_method, created_at
       FROM payment_orders
       WHERE payment_intent_id = ?`,
      [paymentIntentId]
    );

    if (!order) {
      return res.status(404).json({ error: "Payment order not found." });
    }

    const paidAt = new Date().toISOString();
    await runQuery(
      `UPDATE payment_orders
       SET status = ?, paid_at = ?, updated_at = ?
       WHERE payment_intent_id = ?`,
      ["paid", paidAt, paidAt, paymentIntentId]
    );

    const invoiceNumber = createInvoiceNumber({ orderId: order.id, issuedAt: paidAt });
    await runQuery(
      `INSERT INTO invoices (
        invoice_number,
        payment_intent_id,
        order_id,
        customer_name,
        customer_email,
        items_json,
        subtotal_amount,
        tax_amount,
        total_amount,
        currency,
        status,
        payment_method,
        issued_at,
        paid_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(payment_intent_id) DO UPDATE SET
        invoice_number = excluded.invoice_number,
        order_id = excluded.order_id,
        customer_name = excluded.customer_name,
        customer_email = excluded.customer_email,
        items_json = excluded.items_json,
        subtotal_amount = excluded.subtotal_amount,
        tax_amount = excluded.tax_amount,
        total_amount = excluded.total_amount,
        currency = excluded.currency,
        status = excluded.status,
        payment_method = excluded.payment_method,
        issued_at = excluded.issued_at,
        paid_at = excluded.paid_at,
        updated_at = excluded.updated_at`,
      [
        invoiceNumber,
        paymentIntentId,
        order.id,
        order.customer_name,
        order.customer_email,
        order.items_json,
        order.total_amount,
        0,
        order.total_amount,
        String(order.currency || "USD").toUpperCase(),
        "paid",
        normalizePaymentMethod(order.payment_method, "card"),
        paidAt,
        paidAt,
        order.created_at || paidAt,
        paidAt
      ]
    );

    const savedInvoice = await getQuery(
      `SELECT
        id,
        invoice_number,
        payment_intent_id,
        order_id,
        customer_name,
        customer_email,
        items_json,
        subtotal_amount,
        tax_amount,
        total_amount,
        currency,
        status,
        payment_method,
        issued_at,
        paid_at,
        created_at,
        updated_at
       FROM invoices
       WHERE payment_intent_id = ?`,
      [paymentIntentId]
    );

    return res.json({
      message: "Payment confirmed.",
      invoice: savedInvoice ? mapInvoiceRow(savedInvoice) : null
    });
  } catch (error) {
    console.error("Failed to confirm payment:", error?.message || error);
    return res.status(500).json({ error: "Could not confirm payment." });
  }
});

app.get("/api/register", (req, res) => {
  db.all(
    `SELECT id, full_name AS fullName, email, company, industry, challenge, registered_at AS registeredAt
     FROM registered_users
     ORDER BY id DESC`,
    (error, rows) => {
      if (error) {
        console.error("Failed to fetch users:", error.message);
        return res.status(500).json({ error: "Could not fetch users." });
      }

      return res.json({ users: rows });
    }
  );
});

// RFQ email endpoint
app.post("/api/rfq", async (req, res) => {
  const { name, email, company, phone, service, message } = req.body || {};

  if (!name || name.trim().length < 2) {
    return res.status(400).json({ error: "Full name must be at least 2 characters." });
  }

  if (!email || !emailPattern.test(email.trim())) {
    return res.status(400).json({ error: "Please provide a valid email address." });
  }

  const smtpUser = process.env.SMTP_USER || "";
  const smtpPass = process.env.SMTP_PASS || "";

  if (!smtpUser || !smtpPass) {
    console.warn("SMTP credentials not configured — RFQ email not sent.");
    return res.status(200).json({ message: "RFQ received. (Email delivery pending SMTP setup.)" });
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: smtpUser, pass: smtpPass }
  });

  const submittedAt = new Date().toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur" });

  const mailOptions = {
    from: `"AD Tech RFQ" <${smtpUser}>`,
    to: "admin@adtech-biz.com",
    replyTo: email.trim(),
    subject: `New Request for Quotation — ${name.trim()}`,
    html: `
      <h2 style="color:#1bc6b0;">New Request for Quotation</h2>
      <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse;width:100%;">
        <tr><td style="padding:6px 12px;font-weight:bold;">Name</td><td style="padding:6px 12px;">${name.trim()}</td></tr>
        <tr style="background:#f4f4f4;"><td style="padding:6px 12px;font-weight:bold;">Email</td><td style="padding:6px 12px;">${email.trim()}</td></tr>
        <tr><td style="padding:6px 12px;font-weight:bold;">Company</td><td style="padding:6px 12px;">${(company || "").trim() || "-"}</td></tr>
        <tr style="background:#f4f4f4;"><td style="padding:6px 12px;font-weight:bold;">Phone</td><td style="padding:6px 12px;">${(phone || "").trim() || "-"}</td></tr>
        <tr><td style="padding:6px 12px;font-weight:bold;">Service Interested</td><td style="padding:6px 12px;">${(service || "").trim() || "-"}</td></tr>
        <tr style="background:#f4f4f4;"><td style="padding:6px 12px;font-weight:bold;">Message</td><td style="padding:6px 12px;">${(message || "").trim() || "-"}</td></tr>
        <tr><td style="padding:6px 12px;font-weight:bold;">Submitted</td><td style="padding:6px 12px;">${submittedAt} (MYT)</td></tr>
      </table>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    return res.status(200).json({ message: "Your quotation request has been sent. We will contact you shortly." });
  } catch (error) {
    console.error("Failed to send RFQ email:", error.message);
    return res.status(500).json({ error: "Failed to send email. Please try again or contact us directly." });
  }
});

// ─── AI Chat ───────────────────────────────────────────────────────────────
const openaiApiKey = process.env.OPENAI_API_KEY || "";

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body || {};

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message is required." });
  }

  if (message.trim().length > 1000) {
    return res.status(400).json({ error: "Message too long." });
  }

  if (!openaiApiKey) {
    return res.status(503).json({ error: "AI assistant is not available yet. Please contact us via the form below." });
  }

  const systemPrompt = `You are the AD Tech assistant, a helpful and professional AI for AD Tech — an enterprise business systems consultancy. AD Tech provides: Sales and Purchase Systems (invoicing, delivery orders, sales orders, costing), Supply Chain Optimization, Finance & Accounting System (GL, AP, AR, budgeting, tax, fixed assets), and Special Customize Systems (custom software, system integration, multi-platform deployment). Be concise, friendly, and professional. For pricing questions, direct users to submit a Request for Quotation via the Contact section. Never fabricate specific prices.`;

  const messages = [{ role: "system", content: systemPrompt }];

  if (Array.isArray(history)) {
    history.slice(-10).forEach((msg) => {
      if (msg && (msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string") {
        messages.push({ role: msg.role, content: msg.content.slice(0, 1000) });
      }
    });
  }

  messages.push({ role: "user", content: message.trim() });

  try {
    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        max_tokens: 400,
        temperature: 0.7
      })
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.json().catch(() => ({}));
      const errCode = errBody?.error?.code || "";
      const errMsg  = errBody?.error?.message || "";
      console.error("OpenAI error:", aiRes.status, errCode, errMsg);

      if (aiRes.status === 401 || errCode === "invalid_api_key") {
        return res.status(502).json({ error: "AI API key is invalid. Please check the OPENAI_API_KEY in Render." });
      }
      if (aiRes.status === 429 || errCode === "insufficient_quota") {
        return res.status(502).json({ error: "OpenAI quota exceeded. Please check your billing at platform.openai.com." });
      }
      if (aiRes.status === 429) {
        return res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
      }
      if (aiRes.status === 404 || errCode === "model_not_found") {
        return res.status(502).json({ error: "AI model unavailable. Please contact support." });
      }
      return res.status(502).json({ error: `AI service error (${aiRes.status}): ${errMsg || "Please try again shortly."}` });
    }

    const aiData = await aiRes.json();
    const reply = aiData.choices?.[0]?.message?.content?.trim() || "Sorry, I couldn't generate a response.";
    return res.json({ reply });
  } catch (err) {
    console.error("Chat endpoint error:", err.message);
    return res.status(500).json({ error: "Failed to reach AI service. Please try again." });
  }
});

app.listen(PORT, () => {
  console.log(`AD Tech server running at http://localhost:${PORT}`);
  console.log(`SQLite DB: ${dbPath}`);
});
