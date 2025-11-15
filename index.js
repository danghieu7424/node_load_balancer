const fs = require("fs");
const http = require("http");
const https = require("https");
const httpProxy = require("http-proxy");
const crypto = require("crypto");

const PORT = 8080;

let servers = loadServers();

const proxy = httpProxy.createProxyServer({});
let index = 0;
const stickyMap = new Map();

/* ============================================
   1) Load servers.json + watcher auto reload
============================================ */
function loadServers() {
  const data = JSON.parse(fs.readFileSync("./servers.json", "utf8"));

  return data.map((s) => ({
    ...s,
    healthy: false,
    responseTime: null,
    lastCheck: null,
    uptime: 0,
    downtime: 0,
    history: [
      " ",
      " ",
      " ",
      " ",
      " ",
      " ",
      " ",
      " ",
      " ",
      " ",
      " ",
      " ",
      " ",
      " ",
      " ",
      " ",
      " ",
      " ",
      " ",
      " ",
    ], // lưu các responseTime gần nhất để vẽ ASCII
  }));
}

fs.watch("./servers.json", () => {
  console.log("\n🔄 Reload servers.json...");
  servers = loadServers();
});

/* ============================================
   2) Sticky Session
============================================ */
function getClientId(req) {
  return crypto
    .createHash("md5")
    .update(
      (req.headers["x-forwarded-for"] || req.socket.remoteAddress) +
        (req.headers["user-agent"] || "")
    )
    .digest("hex");
}

function getStickyServer(clientId) {
  if (!stickyMap.has(clientId)) return null;
  const url = stickyMap.get(clientId);
  const alive = servers.find((s) => s.url === url && s.healthy);
  return alive ? alive.url : null;
}

/* ============================================
   3) Round-robin chọn server sống
============================================ */
function chooseServer() {
  const alive = servers.filter((s) => s.healthy);
  if (!alive.length) return null;

  // 1. Lấy server tại index hiện tại (lần đầu là 0)
  const serverUrl = alive[index].url;

  // 2. Cập nhật index cho LẦN SAU
  index = (index + 1) % alive.length;

  // 3. Trả về server đã lấy ở bước 1
  return serverUrl;
}

/* ============================================
   4) Health Check + Uptime + lịch sử để vẽ ASCII
============================================ */
function checkHealth() {
  servers.forEach((s) => {
    const client = s.url.startsWith("https") ? https : http;

    const start = Date.now();

    client
      .get(s.url, () => {
        s.healthy = true;
        s.responseTime = Date.now() - start;
        s.lastCheck = new Date().toLocaleTimeString();
        s.uptime++;
        s.history.push(s.responseTime);

        if (s.history.length > 20) s.history.shift(); // Lưu max 20 giá trị
      })
      .on("error", () => {
        s.healthy = false;
        s.responseTime = null;
        s.lastCheck = new Date().toLocaleTimeString();
        s.downtime++;
        s.history.push(0);

        if (s.history.length > 20) s.history.shift();
      });
  });
}

/* ============================================
   5) ASCII Graph (biểu đồ latency)
============================================ */
function asciiGraph(values) {
  if (!values.length) return "";

  const max = Math.max(...values);
  const chars = " ▁▂▃▄▅▆▇█";

  return values
    .map((v) => {
      if (v === 0) return "·";
      const idx = Math.floor((v / max) * (chars.length - 1));
      return chars[idx];
    })
    .join("");
}

/* ============================================
   6) In bảng trạng thái
============================================ */
function printStatus() {
  console.clear();
  console.log("=== SERVER STATUS ===");
  console.log(`=== http://localhost:${PORT} ===\n`);

  const table = servers.map((s) => ({
    URL: s.url,
    REGION: s.region || "-",
    HEALTH: s.healthy ? "🟢" : "🔴",
    "UPTIME (%)": ((s.uptime / (s.uptime + s.downtime + 1)) * 100).toFixed(1),
    "RESP (ms)": s.responseTime || "-",
    GRAPH: asciiGraph(s.history),
    "LAST CHECK": s.lastCheck || "-",
  }));

  console.table(table);
}

setInterval(checkHealth, 5000);
setInterval(printStatus, 5000);

/* ============================================
   7) Load Balancer chính
============================================ */
http
  .createServer((req, res) => {
    const clientId = getClientId(req);

    let target = getStickyServer(clientId);
    if (!target) {
      target = chooseServer();
      if (target) stickyMap.set(clientId, target);
    }

    if (!target) {
      res.writeHead(503);
      return res.end("No backend servers alive");
    }

    function send(retry = false) {
      // TẠO OPTIONS Ở ĐÂY
      const options = {
        target,
        changeOrigin: true, // <-- THÊM DÒNG NÀY
      };

      proxy.web(req, res, options, (err) => {
        // Dùng `options` mới
        if (!retry) {
          target = chooseServer();
          // Cập nhật lại target trong options cho lần retry
          options.target = target;
          return send(true);
        }
        res.writeHead(500);
        res.end("Load balancer error");
      });
    }

    send();
  })
  .listen(PORT, () => {
    console.log("Load balancer running...");
  });
