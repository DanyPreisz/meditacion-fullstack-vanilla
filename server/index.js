import { URL } from "node:url";
import { connect, isReady, mapSession, sessions, toId, users } from "./db.js";
import { createApp, readJson, sendEmpty, sendJson, serveStatic } from "./http.js";
import { getUserFromRequest, hashPassword, signToken, verifyPassword } from "./middleware/auth.js";

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
function usernameQuery(username) { return new RegExp("^" + username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i"); }
function requireUser(req, res) { const user = getUserFromRequest(req); if (!user) { sendJson(res, 401, { error: "No autenticado" }); return null; } return user; }
function dayKey(date = new Date()) { return new Date(date.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10); }
function previous(day) { return new Date(new Date(`${day}T03:00:00.000Z`).getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10); }
function streakOf(days) {
  if (!days.length) return 0;
  const set = new Set(days);
  let cursor = set.has(dayKey()) ? dayKey() : previous(dayKey());
  let streak = 0;
  while (set.has(cursor)) { streak += 1; cursor = previous(cursor); }
  return streak;
}

const server = createApp(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const { pathname } = url;
  const method = req.method || "GET";
  if (pathname === "/health") return sendJson(res, 200, { ok: true, db: isReady() });
  if (pathname.startsWith("/api/") && !isReady()) return sendJson(res, 503, { error: "Base no lista" });
  if (!pathname.startsWith("/api/")) return serveStatic(req, res);

  if (method === "POST" && pathname === "/api/auth/register") {
    const body = await readJson(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!USERNAME_RE.test(username)) return sendJson(res, 400, { error: "Usuario: 3-20 caracteres, letras, numeros y _" });
    if (password.length < 6) return sendJson(res, 400, { error: "La contrasena debe tener al menos 6 caracteres" });
    if (await users().findOne({ username: usernameQuery(username) })) return sendJson(res, 409, { error: "Ese usuario ya existe" });
    const result = await users().insertOne({ username, passwordHash: hashPassword(password), createdAt: new Date() });
    const user = { id: String(result.insertedId), username };
    return sendJson(res, 201, { user, token: signToken(user) });
  }
  if (method === "POST" && pathname === "/api/auth/login") {
    const body = await readJson(req);
    const username = String(body.username || "").trim();
    const row = await users().findOne({ username: usernameQuery(username) });
    if (!row || !verifyPassword(String(body.password || ""), row.passwordHash)) return sendJson(res, 401, { error: "Usuario o contrasena incorrectos" });
    const user = { id: String(row._id), username: row.username };
    return sendJson(res, 200, { user, token: signToken(user) });
  }
  if (method === "GET" && pathname === "/api/auth/me") {
    const user = requireUser(req, res);
    if (!user) return;
    return sendJson(res, 200, { user });
  }

  const user = requireUser(req, res);
  if (!user) return;
  const userId = user.id;

  if (method === "GET" && pathname === "/api/sessions") {
    const rows = await sessions().find({ userId }).sort({ day: -1 }).limit(60).toArray();
    const total = rows.reduce((sum, row) => sum + row.minutes, 0);
    return sendJson(res, 200, { sessions: rows.map(mapSession), streak: streakOf(rows.map((row) => row.day)), total });
  }
  if (method === "POST" && pathname === "/api/sessions") {
    const body = await readJson(req);
    const minutes = Math.min(180, Math.max(1, Math.round(Number(body.minutes) || 10)));
    const day = /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? body.day : dayKey();
    const current = await sessions().findOne({ userId, day });
    await sessions().updateOne({ userId, day }, { $set: { userId, day, minutes: (current?.minutes || 0) + minutes, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    return sendJson(res, 201, { session: mapSession(await sessions().findOne({ userId, day })) });
  }
  const match = pathname.match(/^\/api\/sessions\/([a-fA-F0-9]{24})$/);
  if (match && method === "DELETE") {
    const result = await sessions().deleteOne({ _id: toId(match[1]), userId });
    if (!result.deletedCount) return sendJson(res, 404, { error: "Sesion no encontrada" });
    return sendEmpty(res, 204);
  }
  sendJson(res, 404, { error: "Ruta no encontrada" });
});

server.listen(PORT, HOST, () => console.log(`Meditacion en http://${HOST}:${PORT}`));
async function bootDb() { for (;;) { try { await connect(); return; } catch (err) { console.error("Mongo no disponible:", err.message); await new Promise((resolve) => setTimeout(resolve, 5000)); } } }
bootDb();
