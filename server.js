const express = require("express");
const dotenv = require("dotenv");
// const path = require("path");
const { MongoClient } = require("mongodb");
const cors = require("cors");

dotenv.config();

const app = express();
// app.use(cors());
app.use(
  cors({
    origin: "https://techscr-spec-tool-frontend.onrender.com",
  }),
);
app.use(express.json({ limit: "2mb" }));

// Serve frontend
// app.use(express.static(path.join(__dirname, "public")));

const { MONGODB_URI, DB_NAME = "techscr", PORT = 3000 } = process.env;

if (!MONGODB_URI) {
  console.error("Missing MONGODB_URI in .env");
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);
let phonesCol;

async function initDb() {
  await client.connect();
  const db = client.db(DB_NAME);
  phonesCol = db.collection("phones");

  await phonesCol.createIndex({ id: 1 }, { unique: true });
  await phonesCol.createIndex({ brand: 1, model: 1 });
  await phonesCol.createIndex({ updated_at: -1 });

  console.log("Mongo connected:", DB_NAME);
}

// PUBLIC: list/search phones
app.get("/api/phones", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  const limit = Math.min(parseInt(req.query.limit || "200", 10), 500);

  const filter = q
    ? {
        $or: [
          { brand: { $regex: q, $options: "i" } },
          { model: { $regex: q, $options: "i" } },
          { "specs.performance.soc": { $regex: q, $options: "i" } },
          { "specs.durability.ip_rating": { $regex: q, $options: "i" } },
        ],
      }
    : {};

  const phones = await phonesCol
    .find(filter, { projection: { _id: 0 } })
    .sort({ updated_at: -1 })
    .limit(limit)
    .toArray();

  res.json({ phones });
});

function isAdmin(req) {
  const key = req.headers["x-admin-key"];
  return key && key === process.env.ADMIN_KEY;
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: "Admin only" });
  next();
}

app.get("/api/admin/check", (req, res) => {
  const got = req.headers["x-admin-key"] || null;
  res.json({
    admin: !!got && got === process.env.ADMIN_KEY,
    got_len: got ? got.length : 0,
  });
});

// PUBLIC: get one phone by id
app.get("/api/phones/:id", async (req, res) => {
  const phone = await phonesCol.findOne(
    { id: req.params.id },
    { projection: { _id: 0 } },
  );
  if (!phone) return res.status(404).json({ error: "Not found" });
  res.json({ phone });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

// ADMIN: create phone
app.post("/api/admin/phones", requireAdmin, async (req, res) => {
  const phone = req.body;

  if (!phone?.id || !phone?.brand || !phone?.model) {
    return res.status(400).json({ error: "id, brand, model required" });
  }

  if (!Array.isArray(phone.variants)) phone.variants = [];
  if (!Array.isArray(phone.tests)) phone.tests = [];
  if (!phone.specs) phone.specs = {};
  if (!phone.release) phone.release = { status: "released", date: null };

  phone.created_at = new Date().toISOString();
  phone.updated_at = new Date().toISOString();

  try {
    await phonesCol.insertOne(phone);
    return res.status(201).json({ ok: true });
  } catch (e) {
    if (e.code === 11000)
      return res.status(409).json({ error: "id already exists" });
    return res.status(500).json({ error: "insert failed" });
  }
});

// ADMIN: update phone (replace full doc)
app.put("/api/admin/phones/:id", requireAdmin, async (req, res) => {
  const phone = req.body;

  if (!phone?.id || phone.id !== req.params.id) {
    return res.status(400).json({ error: "body.id must match URL id" });
  }

  phone.updated_at = new Date().toISOString();

  const result = await phonesCol.replaceOne({ id: req.params.id }, phone, {
    upsert: false,
  });
  if (!result.matchedCount) return res.status(404).json({ error: "Not found" });

  return res.json({ ok: true });
});

// ADMIN: delete phone (optional)
app.delete("/api/admin/phones/:id", requireAdmin, async (req, res) => {
  const result = await phonesCol.deleteOne({ id: req.params.id });
  if (!result.deletedCount) return res.status(404).json({ error: "Not found" });
  return res.json({ ok: true });
});

// ADMIN: seed many phones at once (optional, but very useful)
app.post("/api/admin/seed", requireAdmin, async (req, res) => {
  const phones = req.body?.phones;
  if (!Array.isArray(phones) || !phones.length) {
    return res.status(400).json({ error: "Body must be { phones: [...] }" });
  }

  const now = new Date().toISOString();
  const docs = phones.map((p) => ({
    ...p,
    variants: Array.isArray(p.variants) ? p.variants : [],
    tests: Array.isArray(p.tests) ? p.tests : [],
    specs: p.specs || {},
    release: p.release || { status: "released", date: null },
    created_at: p.created_at || now,
    updated_at: now,
  }));

  // upsert each by id
  const ops = docs.map((d) => ({
    updateOne: {
      filter: { id: d.id },
      update: { $set: d },
      upsert: true,
    },
  }));

  const result = await phonesCol.bulkWrite(ops);
  return res.json({ ok: true, result });
});

initDb().then(() => {
  app.listen(PORT, () =>
    console.log(`Server running: http://localhost:${PORT}`),
  );
});
