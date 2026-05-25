require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const mongoose = require("mongoose");
const axios    = require("axios");
const cron     = require("node-cron");

const app = express();
app.use(cors());
app.use(express.json());

// ── MongoDB Atlas connection ───────────────────────────────
mongoose
  .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
  .then(() => console.log("✅ Connected to MongoDB Atlas"))
  .catch((err) => { console.error("❌ MongoDB error:", err.message); process.exit(1); });

// ── WeatherCache schema ───────────────────────────────────
// Two documents ever: one for "current", one for "forecast"
// updatedAt drives the 5-minute TTL check
const WeatherCacheSchema = new mongoose.Schema(
  {
    type:      { type: String, enum: ["current", "forecast"], required: true, unique: true },
    data:      { type: mongoose.Schema.Types.Mixed, required: true },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "weatherData" }
);
const WeatherCache = mongoose.model("WeatherCache", WeatherCacheSchema);

// ── Config ────────────────────────────────────────────────
const OWM      = "https://api.openweathermap.org/data/2.5";
const API_KEY  = process.env.OPENWEATHER_API_KEY;
const LAT      = process.env.WEATHER_LAT || "12.361610068733976";
const LON      = process.env.WEATHER_LON || "76.62865027769722";
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

// true  → cache is still fresh, skip API call
// false → cache is stale or missing, must call OWM
function isFresh(doc) {
  return doc && (Date.now() - new Date(doc.updatedAt).getTime()) < CACHE_TTL;
}

// ── Cache-first service functions ─────────────────────────
// Workflow:
//   1. Check MongoDB for existing document
//   2. If < 5 minutes old  →  return MongoDB data immediately
//   3. If stale or missing →  call OpenWeatherMap, update MongoDB, return fresh data
// Multiple simultaneous users within the same 5-min window
// all get the same MongoDB document — zero extra API calls.

async function getCurrentWeather() {
  const cached = await WeatherCache.findOne({ type: "current" });
  if (isFresh(cached)) {
    const age = Math.round((Date.now() - new Date(cached.updatedAt).getTime()) / 1000);
    console.log(`📦 [current] from MongoDB cache (age: ${age}s)`);
    return { ...cached.data, _cache: { hit: true, cachedAt: cached.updatedAt } };
  }
  console.log("🌐 [current] cache miss – calling OpenWeatherMap");
  const { data } = await axios.get(
    `${OWM}/weather?lat=${LAT}&lon=${LON}&appid=${API_KEY}&units=metric`
  );
  const now = new Date();
  await WeatherCache.findOneAndUpdate(
    { type: "current" },
    { type: "current", data, updatedAt: now },
    { upsert: true, new: true }
  );
  console.log("✅ [current] MongoDB cache updated");
  return { ...data, _cache: { hit: false, cachedAt: now } };
}

async function getForecast() {
  const cached = await WeatherCache.findOne({ type: "forecast" });
  if (isFresh(cached)) {
    const age = Math.round((Date.now() - new Date(cached.updatedAt).getTime()) / 1000);
    console.log(`📦 [forecast] from MongoDB cache (age: ${age}s)`);
    return { ...cached.data, _cache: { hit: true, cachedAt: cached.updatedAt } };
  }
  console.log("🌐 [forecast] cache miss – calling OpenWeatherMap");
  const { data } = await axios.get(
    `${OWM}/forecast?lat=${LAT}&lon=${LON}&appid=${API_KEY}&units=metric&cnt=40`
  );
  const now = new Date();
  await WeatherCache.findOneAndUpdate(
    { type: "forecast" },
    { type: "forecast", data, updatedAt: now },
    { upsert: true, new: true }
  );
  console.log("✅ [forecast] MongoDB cache updated");
  return { ...data, _cache: { hit: false, cachedAt: now } };
}

// ── Routes ────────────────────────────────────────────────
app.get("/api/weather/current", async (req, res) => {
  try { res.json(await getCurrentWeather()); }
  catch (err) {
    console.error("❌ /current:", err.message);
    res.status(500).json({ error: "Failed to fetch weather", details: err.message });
  }
});

app.get("/api/weather/forecast", async (req, res) => {
  try { res.json(await getForecast()); }
  catch (err) {
    console.error("❌ /forecast:", err.message);
    res.status(500).json({ error: "Failed to fetch forecast", details: err.message });
  }
});

app.get("/api/healthz", (req, res) =>
  res.json({ status: "ok", time: new Date().toISOString() })
);

// ── Auto-refresh cron ─────────────────────────────────────
// Runs every 5 minutes in background so MongoDB stays warm.
// The very first user after each 5-min interval never waits
// for an API call — the cache is always pre-filled.
cron.schedule("*/5 * * * *", async () => {
  console.log("🔄 Cron: refreshing weather cache...");
  try {
    await Promise.all([getCurrentWeather(), getForecast()]);
    console.log("✅ Cron: cache refreshed");
  } catch (err) { console.error("❌ Cron failed:", err.message); }
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀  GSSS College Weather Backend`);
  console.log(`    Current : http://localhost:${PORT}/api/weather/current`);
  console.log(`    Forecast: http://localhost:${PORT}/api/weather/forecast`);
  console.log(`    Cache TTL: 5 minutes  |  DB: weatherData collection\n`);
});