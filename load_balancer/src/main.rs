use axum::{
    body::Body,
    extract::{ConnectInfo, Request, State},
    response::{Html, IntoResponse, Response, Sse},
    routing::{get, any},
    Router,
};
use axum::response::sse::{Event, KeepAlive};
use futures::stream::{Stream, StreamExt}; // Import Stream trait
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    convert::Infallible,
    net::SocketAddr,
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
// Import thư viện tạo bảng
use comfy_table::{presets::UTF8_FULL, Table};
use crossterm::{
    execute,
    terminal::{Clear, ClearType},
    cursor::MoveTo,
};
// use std::io::Write;

const PORT: u16 = 8080;

const DASHBOARD_HTML: &str = r#"
<!DOCTYPE html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <title>Load Balancer Status</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          sans-serif;
        margin: 2em;
        background-color: #f8f9fa;
      }
      h1 {
        color: #343a40;
      }
      table {
        border-collapse: collapse;
        width: 100%;
        background-color: #fff;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      }
      th,
      td {
        border: 1px solid #dee2e6;
        padding: 12px;
        text-align: left;
      }
      th {
        background-color: #f1f3f5;
      }
    </style>
  </head>
  <body>
    <h1>Load Balancer Dashboard (Rust/Axum)</h1>
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
      <tbody id="dashboard-tbody"></tbody>
    </table>

    <script>
      const tbody = document.getElementById("dashboard-tbody");

      // Hàm tạo graph
      function createGraph(values) {
        const numericValues = values.filter((v) => typeof v === "number");
        const max = numericValues.length > 0 ? Math.max(...numericValues) : 1;

        let graphHtml =
          '<div style="display: flex; align-items: flex-end; justify-content: center; gap: 1px; height: 20px; min-width: 60px;">';

        graphHtml += values
          .map((v) => {
            if (typeof v !== "number") {
              return '<div style="width: .5rem; height: 1px; background-color: #e9ecef; border-radius: 1px;"></div>';
            }
            if (v === 0) {
              return '<div style="width: .5rem; height: 2px; background-color: #dc3545; border-radius: 1px;" title="DOWN"></div>';
            }
            const height = Math.max(1, (v / max) * 20);
            // Lưu ý: Đã bỏ dấu \ trước ${}
            return `<div style="width: .5rem; height: ${height}px; background-color: #007bff; border-radius: 1px;" title="${v}ms"></div>`;
          })
          .join("");

        graphHtml += "</div>";
        return graphHtml;
      }

      // Hàm cập nhật nội dung bảng
      function updateTable(servers) {
        let tableRows = "";
        servers.forEach((s) => {
          const uptimePercent = (
            (s.uptime / (s.uptime + s.downtime + 1)) *
            100
          ).toFixed(1);

          const healthStatus = s.healthy
            ? '<span style="color: green;">🟢 ALIVE</span>'
            : '<span style="color: red;">🔴 DOWN</span>';

          const graph = createGraph(s.history);

          // Lưu ý: Đã bỏ dấu \ trước ${}
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
        tbody.innerHTML = tableRows;
      }

      // Hàm kết nối SSE
      function connect() {
        // Kết nối đến route SSE của server Rust
        const evtSource = new EventSource("/load-balancer/events");

        evtSource.onopen = () => {
          console.log("SSE Connection established!");
        };

        evtSource.onmessage = (event) => {
          try {
            const servers = JSON.parse(event.data);
            updateTable(servers);
          } catch (e) {
            console.error("Error parsing SSE data", e);
          }
        };

        evtSource.onerror = (err) => {
          console.error("EventSource error:", err);
          // EventSource tự động reconnect, không cần code thêm logic
        };
      }

      // Bắt đầu kết nối khi trang được tải
      connect();
    </script>
  </body>
</html>
"#;

// --- 1. Cấu trúc dữ liệu ---

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ServerConfig {
    url: String,
    region: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
// QUAN TRỌNG: Tự động đổi tên field sang camelCase khi gửi JSON
// Ví dụ: response_time -> responseTime (để khớp với JS)
#[serde(rename_all = "camelCase")] 
struct ServerStatus {
    url: String,
    region: String,
    healthy: bool,
    response_time: Option<u128>,
    last_check: Option<String>,
    uptime: u64,
    downtime: u64,
    history: Vec<Option<u128>>,
}

struct AppState {
    servers: Vec<ServerStatus>,
    sticky_map: HashMap<String, String>,
    rr_index: usize,
    // Đưa channel vào trong AppState để dễ quản lý
    tx: broadcast::Sender<String>,
}

type SharedState = Arc<RwLock<AppState>>;

// --- 2. Helper Functions ---

// Hàm vẽ biểu đồ ASCII từ lịch sử response time
fn ascii_graph(history: &[Option<u128>]) -> String {
    // Các ký tự block để vẽ độ cao
    let chars = vec![' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    
    // Tìm giá trị lớn nhất để scale biểu đồ
    let valid_values: Vec<u128> = history.iter().filter_map(|&v| v).collect();
    let max = *valid_values.iter().max().unwrap_or(&1); // Tránh chia cho 0

    history.iter().map(|val| {
        match val {
            None => '·', // Chưa có dữ liệu (null)
            Some(0) => 'x', // Server chết hoặc lỗi
            Some(v) => {
                // Tính toán độ cao tương đối
                let ratio = *v as f64 / max as f64;
                let idx = (ratio * (chars.len() - 1) as f64).round() as usize;
                chars[idx]
            }
        }
    }).collect()
}

// Hàm in bảng trạng thái ra terminal
fn print_status_table(state: &SharedState) {
    let r = state.read().unwrap();

    // Dùng Crossterm để xóa sạch màn hình và bộ nhớ đệm scroll
    let mut stdout = std::io::stdout();
    execute!(
        stdout,
        Clear(ClearType::All),   // Xóa màn hình hiện tại
        Clear(ClearType::Purge), // Xóa lịch sử cuộn (Scrollback) -> QUAN TRỌNG
        MoveTo(0, 0)             // Đưa con trỏ về góc trái trên
    ).unwrap();

    println!("=== SERVER STATUS ===");
    println!("=== http://localhost:{} ===", PORT);
    println!("=== http://localhost:{}/load-balancer/dashboard ===\n", PORT);

    let mut table = Table::new();
    table.load_preset(UTF8_FULL)
         .set_content_arrangement(comfy_table::ContentArrangement::Dynamic);

    table.set_header(vec![
        "(index)", "URL", "REGION", "HEALTH", "UPTIME (%)", "RESP (ms)", "GRAPH", "LAST CHECK"
    ]);

    for (i, s) in r.servers.iter().enumerate() {
        let health_icon = if s.healthy { "🟢" } else { "🔴" };
        
        let total_checks = s.uptime + s.downtime;
        let uptime_pct = if total_checks > 0 {
            (s.uptime as f64 / total_checks as f64) * 100.0
        } else {
            0.0
        };

        let resp_str = s.response_time.map(|t| t.to_string()).unwrap_or("-".to_string());
        let last_check = s.last_check.clone().unwrap_or("-".to_string());

        table.add_row(vec![
            i.to_string(),
            s.url.clone(),
            s.region.clone(),
            health_icon.to_string(),
            format!("{:.1}", uptime_pct),
            resp_str,
            ascii_graph(&s.history),
            last_check,
        ]);
    }

    println!("{table}");
}
// server

fn load_servers() -> Vec<ServerStatus> {
    // Đọc file servers.json
    let data = std::fs::read_to_string("servers.json").unwrap_or_else(|_| {
        println!("⚠️ Không tìm thấy servers.json, dùng danh sách rỗng.");
        "[]".to_string()
    });
    
    let configs: Vec<ServerConfig> = serde_json::from_str(&data).unwrap_or_else(|_| Vec::new());

    configs.into_iter().map(|s| ServerStatus {
        url: s.url,
        region: s.region.unwrap_or_else(|| "-".to_string()),
        healthy: false,
        response_time: None,
        last_check: None,
        uptime: 0,
        downtime: 0,
        history: vec![None; 20],
    }).collect()
}

fn get_client_id(ip: SocketAddr, headers: &axum::http::HeaderMap) -> String {
    let ua = headers.get("user-agent").and_then(|v| v.to_str().ok()).unwrap_or("");
    let raw = format!("{}{}", ip.ip(), ua);
    format!("{:x}", md5::compute(raw))
}

fn choose_server(state: &mut AppState, client_id: &str) -> Option<String> {
    // 1. Kiểm tra Sticky Session
    if let Some(url) = state.sticky_map.get(client_id) {
        if let Some(s) = state.servers.iter().find(|s| s.url == *url && s.healthy) {
            println!("🎯 Sticky Hit: {}", s.url);
            return Some(s.url.clone());
        } else {
            println!("⚠️ Sticky Server ({}) đã chết hoặc không tồn tại. Chuyển sang Round Robin.", url);
        }
    }

    // 2. Lọc danh sách các server đang sống (Healthy = true)
    let alive_indices: Vec<usize> = state.servers.iter()
        .enumerate()
        .filter(|(_, s)| s.healthy)
        .map(|(i, _)| i)
        .collect();

    // --- DEBUG LOG ---
    if alive_indices.is_empty() {
        println!("❌ LỖI: Không có server nào sống!");
        println!("--- Trạng thái hiện tại ---");
        for s in &state.servers {
            println!(" - {}: Healthy={}", s.url, s.healthy);
        }
        println!("---------------------------");
        return None; // Trả về None -> Gây ra lỗi 503 "No backend servers alive"
    }

    // 3. Round Robin
    state.rr_index = (state.rr_index + 1) % alive_indices.len();
    let chosen_index = alive_indices[state.rr_index];
    
    let chosen_url = state.servers[chosen_index].url.clone();
    state.sticky_map.insert(client_id.to_string(), chosen_url.clone());

    println!("✅ Đã chọn server: {}", chosen_url);
    Some(chosen_url)
}

// --- 3. Background Task (Đã sửa lỗi check status) ---

async fn health_check_task(state: SharedState) {
    let client = Client::builder()
        .timeout(Duration::from_secs(2))
        .user_agent("Mozilla/5.0 (Rust Load Balancer)")
        .build()
        .unwrap();

    loop {
        let servers_to_check: Vec<(usize, String)> = {
            let r = state.read().unwrap();
            r.servers.iter().enumerate().map(|(i, s)| (i, s.url.clone())).collect()
        };

        let mut updates = Vec::new();

        for (idx, url) in servers_to_check {
            let health_url = if url.ends_with('/') {
                format!("{}healthz", url)
            } else {
                format!("{}/healthz", url)
            };

            let start = std::time::Instant::now();
            
            // Gửi request
            let result = client.get(&health_url).send().await;
            
            let duration = start.elapsed().as_millis();
            let now_str = chrono::Local::now().format("%H:%M:%S").to_string();

            // --- SỬA ĐOẠN NÀY ---
            // Kiểm tra kỹ: Phải kết nối được VÀ Status phải là 2xx (Success)
            let is_healthy = match result {
                Ok(response) => {
                    // response.status().is_success() trả về true nếu mã là 200-299
                    response.status().is_success()
                },
                Err(_) => false, // Lỗi kết nối mạng (Connection refused, Timeout...)
            };

            updates.push((idx, is_healthy, duration, now_str));
        }

        {
            let mut w = state.write().unwrap();
            for (idx, healthy, time, timestamp) in updates {
                let s = &mut w.servers[idx];
                s.last_check = Some(timestamp);
                
                if healthy {
                    s.healthy = true;
                    s.response_time = Some(time);
                    s.uptime += 1;
                    s.history.push(Some(time));
                } else {
                    s.healthy = false;
                    s.response_time = None;
                    s.downtime += 1;
                    s.history.push(Some(0));
                }
                if s.history.len() > 20 { s.history.remove(0); }
            }
            
            let json_data = serde_json::to_string(&w.servers).unwrap();
            let _ = w.tx.send(json_data);
        }

        // --- THÊM DÒNG NÀY ĐỂ IN BẢNG ---
        print_status_table(&state);
        
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

// --- 4. Handlers ---

async fn dashboard_handler() -> Html<&'static str> {
    // Html(include_str!("dashboard.html"))
    Html(DASHBOARD_HTML)
}

async fn sse_handler(
    State(state): State<SharedState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    // 1. Lấy receiver từ state
    let (rx, initial_data) = {
        let s = state.read().unwrap();
        (s.tx.subscribe(), serde_json::to_string(&s.servers).unwrap())
    };

    // 2. Tạo stream từ broadcast receiver
    let stream = tokio_stream::wrappers::BroadcastStream::new(rx)
        .map(|msg| {
            match msg {
                Ok(data) => Event::default().data(data),
                Err(_) => Event::default().comment("missed message"),
            }
        })
        .map(Ok);

    // 3. Gửi ngay dữ liệu hiện tại (initial_data) trước khi stream bắt đầu
    // Để người dùng không thấy bảng trắng khi mới F5
    let initial_stream = tokio_stream::once(Ok(Event::default().data(initial_data)));
    
    // Nối stream khởi tạo với stream lắng nghe
    let combined_stream = initial_stream.chain(stream);

    Sse::new(combined_stream).keep_alive(KeepAlive::default())
}

async fn proxy_handler(
    State(state): State<SharedState>,
    ConnectInfo(ip): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap, // Header gốc từ trình duyệt
    req: Request,
) -> Response {
    let client_id = get_client_id(ip, &headers);
    
    let target_url = {
        let mut w = state.write().unwrap();
        choose_server(&mut w, &client_id)
    };

    match target_url {
        Some(base_url) => {
            let path = req.uri().path();
            let query = req.uri().query().map(|q| format!("?{}", q)).unwrap_or_default();
            let final_url = format!("{}{}{}", base_url.trim_end_matches('/'), path, query);

            // 1. Parse URL đích để lấy Hostname (ví dụ: p.dh74.io.vn)
            let parsed_url = reqwest::Url::parse(&base_url).unwrap();
            let target_host = parsed_url.host_str().unwrap_or("");

            let client = Client::builder()
                // Quan trọng: Tắt verify SSL nếu server đích dùng self-signed hoặc lỗi cert
                // Nhưng với p.dh74.io.vn thì không cần dòng này cũng được
                .danger_accept_invalid_certs(true) 
                .build()
                .unwrap();

            let method = req.method().clone();
            let body = req.into_body(); 

            // 2. Tạo bộ Header mới để gửi đi
            let mut new_headers = headers.clone();
            
            // --- SỬA QUAN TRỌNG Ở ĐÂY ---
            // Thay thế Host: localhost:8080 bằng Host: p.dh74.io.vn
            new_headers.insert("host", target_host.parse().unwrap());
            // Thêm Referer để server đích không chặn
            new_headers.insert("referer", base_url.parse().unwrap());

            // Xóa header nén (gzip/br) để tránh lỗi decode khi proxy trả về
            new_headers.remove("accept-encoding"); 

            println!("Proxying to: {} (Host: {})", final_url, target_host);

            match client.request(method, &final_url)
                .headers(new_headers) // Dùng header đã sửa
                .body(reqwest::Body::wrap_stream(body.into_data_stream()))
                .send()
                .await 
            {
                Ok(res) => {
                    let mut response_builder = Response::builder().status(res.status());
                    *response_builder.headers_mut().unwrap() = res.headers().clone();
                    
                    // Xóa các header bảo mật cors/frame của server đích để trình duyệt local hiển thị được
                    // (Tùy chọn, nhưng hữu ích khi proxy trang web khác)
                    response_builder.headers_mut().unwrap().remove("content-security-policy");
                    response_builder.headers_mut().unwrap().remove("x-frame-options");

                    response_builder.body(Body::from_stream(res.bytes_stream())).unwrap()
                },
                Err(e) => {
                    println!("Proxy Error: {}", e);
                    (axum::http::StatusCode::BAD_GATEWAY, format!("Bad Gateway: {}", e)).into_response()
                }
            }
        },
        None => (axum::http::StatusCode::SERVICE_UNAVAILABLE, "No backend servers alive").into_response()
    }
}

// --- 5. Main ---

#[tokio::main]
async fn main() {
    // Tạo channel broadcast
    let (tx, _rx) = broadcast::channel::<String>(100);

    // Khởi tạo State
    let shared_state = Arc::new(RwLock::new(AppState {
        servers: load_servers(),
        sticky_map: HashMap::new(),
        rr_index: 0,
        tx, // Lưu tx vào state luôn
    }));

    // Chạy Health Check
    let state_clone = shared_state.clone();
    tokio::spawn(async move {
        health_check_task(state_clone).await;
    });

    println!("🚀 Load balancer (Rust) đang chạy tại http://localhost:{}", PORT);
    println!("📊 Dashboard: http://localhost:{}/load-balancer/dashboard", PORT);

    // Router đơn giản hơn (Dùng chung 1 State)
    let app = Router::new()
        .route("/load-balancer/dashboard", get(dashboard_handler))
        .route("/load-balancer/events", get(sse_handler))
        .fallback(any(proxy_handler))
        .layer(CorsLayer::permissive())
        .with_state(shared_state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", PORT)).await.unwrap();
    
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
}