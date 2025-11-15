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
   5.1) HTML Graph (biểu đồ latency cho web)
============================================ */
function htmlGraph(values) {
  // Tìm giá trị max, chỉ lọc các giá trị là số
  const numericValues = values.filter((v) => typeof v === "number");
  const max = numericValues.length > 0 ? Math.max(...numericValues) : 1;

  // Bắt đầu container
  let graphHtml =
    '<div style="display: flex; align-items: flex-end; justify-content: center; gap: 1px; height: 20px; min-width: 60px;">';

  graphHtml += values
    .map((v) => {
      if (typeof v !== "number") {
        // Slot trống ban đầu (" ")
        return '<div style="width: .5rem; height: 1px; background-color: #e9ecef; border-radius: 1px;"></div>';
      }

      if (v === 0) {
        // Check bị lỗi (DOWN)
        return '<div style="width: .5rem; height: 2px; background-color: #dc3545; border-radius: 1px;" title="DOWN"></div>';
      }

      // Check thành công
      const height = Math.max(1, (v / max) * 20); // Max 20px, min 1px
      return `<div style="width: .5rem; height: ${height}px; background-color: #007bff; border-radius: 1px;" title="${v}ms"></div>`;
    })
    .join("");

  graphHtml += "</div>";
  return graphHtml;
}

/* ============================================
   6) In bảng trạng thái
============================================ */
function printStatus() {
  console.clear();
  console.log("=== SERVER STATUS ===");
  console.log(`=== http://localhost:${PORT} ===\n`);
  console.log(`=== http://localhost:${PORT}/load-balancer/dashboard ===\n`);

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
   6.1) TẠO HTML CHO DASHBOARD
============================================ */
function generateDashboardHtml() {
  let tableRows = "";
  servers.forEach((s) => {
    const uptimePercent = (
      (s.uptime / (s.uptime + s.downtime + 1)) *
      100
    ).toFixed(1);
    const healthStatus = s.healthy
      ? '<span style="color: green;">🟢 ALIVE</span>'
      : '<span style="color: red;">🔴 DOWN</span>';

    // SỬ DỤNG HÀM MỚI
    const graph = htmlGraph(s.history);

    tableRows += `
      <tr>
        <td>${s.url}</td>
        <td>${s.region || "-"}</td>
        <td>${healthStatus}</td>
        <td>${uptimePercent} %</td>
        <td>${s.responseTime || "-"}</td>
        <td>${graph}</td>
        <td>${s.lastCheck || "-"}</td>
      </tr>
    `;
  });

  return `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8">
      <title>Load Balancer Status</title>
      <meta http-equiv="refresh" content="5">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 2em; background-color: #f8f9fa; }
        h1 { color: #343a40; }
        table { border-collapse: collapse; width: 100%; background-color: #fff; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        th, td { border: 1px solid #dee2e6; padding: 12px; text-align: left; }
        th { background-color: #f1f3f5; }
      </style>
    </head>
    <body>
      <h1>Load Balancer Dashboard</h1>
      <table>
        <thead>
          <tr>
            <th>URL</th>
            <th>Region</th>
            <th>Health</th>
            <th>Uptime (%)</th>
            <th>Resp (ms)</th>
            <th>Latency Graph</th>
            <th>Last Check</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </body>
    </html>
  `;
}

/* ============================================
   7) Load Balancer chính
============================================ */
http
  .createServer((req, res) => {
    // --- THÊM ĐOẠN NÀY VÀO ---
    // Kiểm tra xem có phải request vào dashboard không
    if (req.url === "/load-balancer/dashboard") {
      const html = generateDashboardHtml();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html); // Trả về HTML và kết thúc
    }
    // --- KẾT THÚC ĐOẠN THÊM ---

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
