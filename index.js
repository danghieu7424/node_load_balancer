const fs = require("fs");
const http = require("http");
const https = require("https");
const httpProxy = require("http-proxy");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");

const PORT = 8080;

let servers = loadServers();

const proxy = httpProxy.createProxyServer({});
let index = 0;
const stickyMap = new Map();

const app = express();
app.use(cors());

let sseClients = [];

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

const watcher = fs.watch("./servers.json", () => {
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
   4) Health Check (Tự động thêm /healthz)
============================================ */
function checkHealth() {
  // Biến mảng các promise
  const promises = servers.map(
    (s) =>
      new Promise((resolve) => {
        // --- BẮT ĐẦU SỬA ---
        // Tự động tạo URL health check, ví dụ: "https://domain.com" -> "https://domain.com/healthz"
        const healthCheckUrl = new URL(s.url);
        healthCheckUrl.pathname =
          healthCheckUrl.pathname.replace(/\/$/, "") + "/healthz";

        const client = healthCheckUrl.protocol === "https:" ? https : http;
        const start = Date.now();

        client
          .get(healthCheckUrl, (res) => {
            // <-- Dùng healthCheckUrl
            // --- KẾT THÚC SỬA ---
            const { statusCode } = res;

            // Chỉ coi là "healthy" nếu status là 2xx
            if (statusCode >= 200 && statusCode < 300) {
              s.healthy = true;
              s.responseTime = Date.now() - start;
              s.uptime++;
              s.history.push(s.responseTime);
            } else {
              // Bất kỳ status nào khác (như 503) đều là "down"
              s.healthy = false;
              s.responseTime = null;
              s.downtime++;
              s.history.push(0);
            }

            s.lastCheck = new Date().toLocaleTimeString(); // Cập nhật last check
            res.resume(); // Hủy response để giải phóng bộ nhớ
            if (s.history.length > 20) s.history.shift();
            resolve();
          })
          .on("error", (err) => {
            s.healthy = false;
            s.responseTime = null;
            s.lastCheck = new Date().toLocaleTimeString();
            s.downtime++;
            s.history.push(0);
            if (s.history.length > 20) s.history.shift();
            resolve();
          });
      })
  );

  // Trả về một promise duy nhất chờ tất cả check hoàn tất
  return Promise.all(promises);
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
async function printStatus() {
  await checkHealth();
  console.clear();
  console.log("=== SERVER STATUS ===");
  console.log(`=== http://localhost:${PORT} ===`);
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

  // --- THAY ĐỔI PHẦN NÀY ---
  // Lấy WebSocket Server từ 'wsInstance' (XÓA BỎ)

  // Gửi dữ liệu cho các client SSE
  const data = JSON.stringify(servers);
  sseClients.forEach((client) => {
    // SSE yêu cầu định dạng "data: {json_string}\n\n"
    client.write(`data: ${data}\n\n`);
  });
  // --- KẾT THÚC THAY ĐỔI ---
}

/* ============================================
  6.1) TẠO HTML CHO DASHBOARD (Phiên bản WebSocket)
============================================ */
function generateDashboardHtml() {
  return `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8">
      <title>Load Balancer Status</title>
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
        <tbody id="dashboard-tbody">
                  </tbody>
      </table>

      <script>
        const tbody = document.getElementById("dashboard-tbody");

        // Hàm tạo graph (sao chép logic từ hàm htmlGraph)
        function createGraph(values) {
          const numericValues = values.filter((v) => typeof v === "number");
          const max = numericValues.length > 0 ? Math.max(...numericValues) : 1;
          
          let graphHtml = '<div style="display: flex; align-items: flex-end; justify-content: center; gap: 1px; height: 20px; min-width: 60px;">';
          graphHtml += values.map((v) => {
            if (typeof v !== "number") {
              return '<div style="width: .5rem; height: 1px; background-color: #e9ecef; border-radius: 1px;"></div>';
            }
            if (v === 0) {
              return '<div style="width: .5rem; height: 2px; background-color: #dc3545; border-radius: 1px;" title="DOWN"></div>';
            }
            const height = Math.max(1, (v / max) * 20);
            return \`<div style="width: .5rem; height: \${height}px; background-color: #007bff; border-radius: 1px;" title="\${v}ms"></div>\`;
          }).join("");
          graphHtml += "</div>";
          return graphHtml;
        }

        // Hàm cập nhật nội dung bảng
        function updateTable(servers) {
          let tableRows = "";
          servers.forEach((s) => {
            const uptimePercent = (
              (s.uptime / (s.uptime + s.downtime + 1)) * 100
            ).toFixed(1);
            const healthStatus = s.healthy
              ? '<span style="color: green;">🟢 ALIVE</span>'
              : '<span style="color: red;">🔴 DOWN</span>';
            const graph = createGraph(s.history);

            tableRows += \`
              <tr>
                <td>\${s.url}</td>
                <td>\${s.region || "-"}</td>
                <td>\${healthStatus}</td>
                <td>\${uptimePercent} %</td>
                <td>\${s.responseTime || "-"}</td>
                <td>\${graph}</td>
                <td>\${s.lastCheck || "-"}</td>
              </tr>
            \`;
          });
          tbody.innerHTML = tableRows;
        }

        // --- THAY THẾ TOÀN BỘ HÀM CONNECT ---
        // Hàm kết nối (Dùng EventSource thay vì WebSocket)
        function connect() {
          // 1. Kết nối đến route /load-balancer/events
          const evtSource = new EventSource("/load-balancer/events");

          evtSource.onopen = () => {
            console.log("SSE Connection established!");
          };

          // 2. Lắng nghe tin nhắn (mặc định là 'onmessage')
          evtSource.onmessage = (event) => {
            const servers = JSON.parse(event.data);
            updateTable(servers);
          };

          // 3. Xử lý lỗi (SSE tự động kết nối lại)
          evtSource.onerror = (err) => {
            console.error("EventSource error:", err);
            // EventSource sẽ tự động thử kết nối lại sau vài giây
          };
        }

        // Bắt đầu kết nối khi trang được tải
        connect();
      </script>
    </body>
    </html>
  `;
}

/* ============================================
  7) Load Balancer chính (Phiên bản Express)
============================================ */

// 1. Route cho trang dashboard HTML
app.get("/load-balancer/dashboard", (req, res) => {
  const html = generateDashboardHtml();
  res.send(html); // Express tự set Content-Type
});

// 2. Route cho Server-Sent Events (SSE)
app.get("/load-balancer/events", (req, res) => {
  // Thiết lập headers cho kết nối SSE (rất quan trọng)
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders(); // Gửi headers ngay lập tức

  // Thêm client (cái 'res') này vào danh sách
  sseClients.push(res);
  console.log("Một client đã kết nối SSE.");

  // Gửi ngay dữ liệu hiện tại (để client không phải chờ 5s)
  res.write(`data: ${JSON.stringify(servers)}\n\n`);

  // Xử lý khi client ngắt kết nối
  req.on("close", () => {
    sseClients = sseClients.filter((client) => client !== res);
    console.log("Client SSE đã ngắt kết nối.");
  });
});

// 3. Route "catch-all" cho tất cả các request CÒN LẠI (proxy)
app.use((req, res) => {
  // --- Mọi logic proxy cũ của bạn giữ nguyên ---
  const clientId = getClientId(req);

  let target = getStickyServer(clientId);
  if (!target) {
    target = chooseServer();
    if (target) stickyMap.set(clientId, target);
  }

  if (!target) {
    res.status(503).send("No backend servers alive");
    return;
  }

  function send(retry = false) {
    const options = {
      target,
      changeOrigin: true,
    };

    proxy.web(req, res, options, (err) => {
      if (!retry) {
        target = chooseServer();
        options.target = target;
        return send(true);
      }
      res.status(500).send("Load balancer error");
    });
  }

  send();
});

// Thay thế dòng app.listen(PORT, ...) cũ bằng 2 dòng này:
const server = app.listen(PORT, () => {
  console.log("Load balancer (Express) đang chạy...");
});

/* ============================================
  8) Graceful Shutdown
============================================ */

// Lưu lại các interval
const printInterval = setInterval(printStatus, 5000);

function gracefulShutdown() {
  console.log("\nSIGINT/SIGTERM received, shutting down gracefully...");

  // 1. Dừng các timer và watcher
  clearInterval(printInterval);
  watcher.close();

  // 2. Đóng tất cả kết nối SSE
  console.log(`Closing ${sseClients.length} SSE connections...`);
  sseClients.forEach((client) => {
    client.end(); // Kết thúc response HTTP
  });

  // 3. Đóng HTTP server
  server.close(() => {
    console.log("HTTP server closed.");
    process.exit(0); // Thoát hoàn toàn
  });

  // Đặt timeout để ép thoát nếu bị kẹt
  setTimeout(() => {
    console.error(
      "Could not close connections in time, forcefully shutting down"
    );
    process.exit(1);
  }, 10000); // 10 giây
}

// Lắng nghe tín hiệu tắt (Ctrl+C)
process.on("SIGINT", gracefulShutdown);
// Lắng nghe tín hiệu restart (từ nodemon/pm2)
process.on("SIGTERM", gracefulShutdown);
