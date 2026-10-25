// vLLM Mission Control SPA Logic
// 100% Offline / Vanilla JS / Zero Em-Dashes
// Conforms to design-taste-frontend guidelines

// API Key Authentication Interceptor
const originalFetch = window.fetch;
let isPromptingApiKey = false;

window.fetch = async function(url, options = {}) {
  options = options || {};
  options.headers = options.headers || {};

  const apiKey = localStorage.getItem('vllm_manager_api_key');
  if (apiKey) {
    if (options.headers instanceof Headers) {
      if (!options.headers.has('Authorization')) {
        options.headers.set('Authorization', `Bearer ${apiKey}`);
      }
    } else if (Array.isArray(options.headers)) {
      options.headers.push(['Authorization', `Bearer ${apiKey}`]);
    } else {
      if (!options.headers['Authorization']) {
        options.headers['Authorization'] = `Bearer ${apiKey}`;
      }
    }
  }

  const response = await originalFetch(url, options);
  if (response.status === 401 && !url.toString().includes('/api/health')) {
    if (!isPromptingApiKey) {
      isPromptingApiKey = true;
      setTimeout(() => {
        const entered = prompt('Hệ thống yêu cầu xác thực vLLM Manager API Key.\nVui lòng nhập API Key:', localStorage.getItem('vllm_manager_api_key') || '');
        if (entered !== null) {
          localStorage.setItem('vllm_manager_api_key', entered.trim());
          window.location.reload();
        }
        isPromptingApiKey = false;
      }, 150);
    }
  }
  return response;
};

function configureApiKey() {
  const currentKey = localStorage.getItem('vllm_manager_api_key') || '';
  const newKey = prompt('Cấu hình vLLM Manager API Key (bỏ trống nếu không dùng):', currentKey);
  if (newKey !== null) {
    localStorage.setItem('vllm_manager_api_key', newKey.trim());
    if (typeof showToast === 'function') {
      showToast('Đã lưu API Key!', 'success');
    }
    window.location.reload();
  }
}

const API = {
  gpuStatus: '/api/gpu/status',
  instanceStatus: '/api/instance/status',
  deployments: '/api/deployments',
  modelsLocal: '/api/models/local',
  modelDelete: '/api/models/delete',
  modelImport: '/api/models/import',
  modelDownload: '/api/models/download',
  modelDownloadStatus: '/api/models/download/status',
  instanceAction: '/api/instance/action',
  instanceSwitch: '/api/instance/switch',
  instanceLogs: '/api/instance/logs',
  loraList: '/api/lora/list',
  loraLoad: '/api/lora/load',
  loraUnload: '/api/lora/unload',
  testChat: '/api/test/chat',
  testModels: '/api/test/models',
  auditLogs: '/api/audit/logs',
  auditClear: '/api/audit/clear'
};

const state = {
  gpus: [],
  models: [],
  instance: null,
  deployments: [],
  modelFilter: 'all',
  currentModel: '',
  isChatStreaming: false,
  chatHistory: [],
  auditLogs: [],
  auditStatus: 'all',
  auditModel: 'all',
  auditSearch: '',
  auditPage: 1,
  auditPageSize: 25,
  auditAutoRefreshTimer: null
};

// Safe XSS Prevention
function escapeHtml(unsafe) {
  if (typeof unsafe !== 'string') return String(unsafe || '');
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Toast Notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.25s ease';
    setTimeout(() => toast.remove(), 260);
  }, 3800);
}

// Workspace Tab Navigation
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn:not(.modal-subtab)').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === tabId);
  });

  if (tabId === 'tab-audit') {
    refreshAuditLogs();
  } else if (tabId === 'tab-logs') {
    refreshLogs();
  } else if (tabId === 'tab-chat') {
    refreshChatModels();
  }
}

// Prompt Presets Insertion
function insertPrompt(text) {
  const input = document.getElementById('chatInput');
  if (input) {
    input.value = text;
    input.focus();
  }
}

// Clear Chat Dialogue
function clearChat() {
  state.chatHistory = [];
  const messagesDiv = document.getElementById('chatMessages');
  if (messagesDiv) {
    messagesDiv.replaceChildren();
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble chat-assistant';
    bubble.textContent = 'Hệ thống điều phối vLLM đã sẵn sàng. Hãy nhập câu hỏi hoặc chọn một trong các câu hỏi mẫu bên trái để kiểm tra tốc độ sinh token và độ trễ phản hồi.';
    messagesDiv.appendChild(bubble);
  }
  const ttft = document.getElementById('metricTtft');
  const tps = document.getElementById('metricTps');
  const tokens = document.getElementById('metricTokens');
  const latency = document.getElementById('metricLatency');
  if (ttft) ttft.textContent = '-- ms';
  if (tps) tps.textContent = '-- t/s';
  if (tokens) tokens.textContent = '-- tokens';
  if (latency) latency.textContent = '-- s';
}

// Live Filter Models Table
function filterModelsTable() {
  const query = (document.getElementById('modelSearchInput')?.value || '').toLowerCase().trim();
  const rows = document.querySelectorAll('#modelsTableBody tr[data-state]');
  rows.forEach(row => {
    const matchesState = state.modelFilter === 'all' || row.dataset.state === state.modelFilter;
    const matchesQuery = row.textContent.toLowerCase().includes(query);
    row.style.display = matchesState && matchesQuery ? '' : 'none';
  });
}

function setModelFilter(filter) {
  state.modelFilter = filter;
  document.querySelectorAll('[data-model-filter]').forEach(btn => {
    const active = btn.dataset.modelFilter === filter;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  filterModelsTable();
}

// ---- Deployments (every vLLM container, not just the primary one)
const ROLE_LABELS = {
  chat: 'LLM',
  decision: 'Decision',
  ocr: 'OCR',
  embedding: 'Embedding',
  rerank: 'Reranker',
  asr: 'ASR'
};

function deploymentHealth(d) {
  if (!d.running) return { cls: 'down', label: d.status === 'exited' ? `Đã dừng (exit ${d.exit_code ?? '?'})` : 'Không chạy' };
  if (d.health === 'healthy' || d.health === 'n/a') return { cls: 'ok', label: 'Healthy' };
  if (d.health === 'starting') return { cls: 'warn', label: 'Đang nạp trọng số' };
  return { cls: 'warn', label: d.health };
}

function formatUptime(startedAt) {
  const t = Date.parse(startedAt || '');
  if (!t) return '';
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (mins < 60) return `${mins} phút`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} giờ`;
  return `${Math.floor(hours / 24)} ngày`;
}

function gpuLabelsFor(uuids) {
  return (uuids || []).map(u => {
    const gpu = state.gpus.find(g => (g.uuid || '').toLowerCase() === u.toLowerCase());
    return gpu ? `GPU ${gpu.index}` : u.substring(4, 12);
  });
}

async function refreshDeployments() {
  try {
    const res = await fetch(API.deployments);
    if (!res.ok) return;
    const data = await res.json();
    state.deployments = data.deployments || [];
    renderDeployments(state.deployments);
    updateServingSummary(data);
    updateLogsContainerOptions(state.deployments);
    if (state.gpus.length) renderGpuGrid(state.gpus);
  } catch (err) {
    console.error('Lỗi nạp danh sách dịch vụ:', err);
  }
}

function updateServingSummary(data) {
  const running = data.running || 0;
  const total = data.total || 0;
  const healthy = data.healthy || 0;
  const primary = state.deployments.find(d => d.is_primary);

  const summary = document.getElementById('servingSummary');
  if (summary) summary.textContent = `${running} / ${total} dịch vụ`;

  const statusBadge = document.getElementById('engineStatusBadge');
  if (statusBadge) {
    let cls = 'badge-emerald', text = 'Online';
    if (running === 0) { cls = 'badge-rose'; text = 'Stopped'; }
    else if (healthy < running) { cls = 'badge-amber'; text = 'Đang nạp...'; }
    else if (running < total) { cls = 'badge-amber'; text = `${total - running} đã dừng`; }
    statusBadge.className = `badge ${cls}`;
    statusBadge.innerHTML = `<span class="dot-pulse"></span> ${escapeHtml(text)}`;
  }

  const val = document.getElementById('bentoServingVal');
  if (val) val.textContent = `${running} / ${total}`;
  const badge = document.getElementById('bentoServingBadge');
  if (badge) {
    badge.textContent = `${healthy} healthy`;
    badge.className = `badge ${healthy === total ? 'badge-emerald' : 'badge-amber'}`;
  }
  const sub = document.getElementById('bentoServingSub');
  if (sub) {
    sub.textContent = primary
      ? `Chính: ${primary.model_id.split('/').pop()} · TP ${primary.tensor_parallel_size}`
      : 'Không tìm thấy container qwen chính';
  }

  const gwBadge = document.getElementById('bentoGatewayBadge');
  const gw = data.gateway || {};
  if (gwBadge) {
    gwBadge.textContent = gw.running ? 'Online' : (gw.status || 'Không chạy');
    gwBadge.className = `badge ${gw.running ? 'badge-emerald' : 'badge-rose'}`;
  }
  const gwVal = document.getElementById('bentoGatewayVal');
  if (gwVal) gwVal.textContent = `${data.gateway_routes || 0} route`;
}

function renderDeployments(deployments) {
  const list = document.getElementById('deployList');
  if (!list) return;
  list.replaceChildren();

  if (deployments.length === 0) {
    list.innerHTML = '<div class="deploy-empty">Không tìm thấy container vLLM nào. Kiểm tra quyền truy cập docker.sock của vllm-manager.</div>';
    return;
  }

  deployments.forEach(d => {
    const h = deploymentHealth(d);
    const row = document.createElement('div');
    row.className = `deploy-row is-${h.cls}`;
    row.setAttribute('role', 'listitem');

    const routes = d.litellm_routes || [];
    const shownRoutes = routes.slice(0, 2).map(r => `<code class="route-chip">${escapeHtml(r)}</code>`).join('');
    const extraRoutes = routes.length > 2
      ? `<span class="route-more" title="${escapeHtml(routes.slice(2).join(', '))}">+${routes.length - 2}</span>` : '';
    const gpus = gpuLabelsFor(d.gpu_uuids).map(g => `<span class="gpu-chip">${escapeHtml(g)}</span>`).join('');
    const uptime = d.running ? formatUptime(d.started_at) : '';
    const ctx = d.max_model_len ? `${Math.round(d.max_model_len / 1024)}K ctx` : '';

    row.innerHTML = `
      <div class="deploy-main">
        <span class="status-dot ${h.cls}" aria-hidden="true"></span>
        <button type="button" class="deploy-name deploy-open" title="Xem cấu hình triển khai">
          <div class="deploy-model">
            ${escapeHtml(d.model_id.split('/').pop())}
            ${d.is_primary ? '<span class="primary-flag">Chính</span>' : ''}
          </div>
          <div class="deploy-meta">
            <span class="mono">${escapeHtml(d.container)}</span>
            <span class="sep">·</span>
            <span class="role-label">${escapeHtml(ROLE_LABELS[d.role] || d.role)}</span>
            ${ctx ? `<span class="sep">·</span><span class="mono">${ctx}</span>` : ''}
          </div>
        </button>
      </div>
      <div class="deploy-health">
        <span class="health-text ${h.cls}">${escapeHtml(h.label)}</span>
        ${uptime ? `<span class="deploy-uptime">${uptime}</span>` : ''}
      </div>
      <div class="deploy-gpus">${gpus || '<span class="muted">--</span>'}${d.host_port ? `<span class="port-chip">:${escapeHtml(d.host_port)}</span>` : ''}</div>
      <div class="deploy-routes">${shownRoutes}${extraRoutes}${routes.length === 0 ? '<span class="muted">Chưa có route</span>' : ''}</div>
      <div class="deploy-actions">
        <button type="button" class="icon-btn" data-act="logs" title="Xem nhật ký" aria-label="Xem nhật ký ${escapeHtml(d.container)}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        </button>
        ${d.running ? `
        <button type="button" class="icon-btn" data-act="restart" title="Khởi động lại" aria-label="Khởi động lại ${escapeHtml(d.container)}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
        <button type="button" class="icon-btn danger" data-act="stop" title="Dừng" aria-label="Dừng ${escapeHtml(d.container)}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>
        </button>` : `
        <button type="button" class="btn btn-secondary btn-sm" data-act="start" aria-label="Bật ${escapeHtml(d.container)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>
          Bật
        </button>`}
      </div>
    `;

    row.querySelector('.deploy-open').addEventListener('click', () => openDeployDrawer(d.container));
    row.querySelector('[data-act="logs"]').addEventListener('click', () => openLogsFor(d.container));
    row.querySelectorAll('[data-act="restart"],[data-act="stop"],[data-act="start"]').forEach(btn => {
      btn.addEventListener('click', () => handleContainerAction(btn.dataset.act, d.container));
    });
    list.appendChild(row);
  });
}

function updateLogsContainerOptions(deployments) {
  const select = document.getElementById('logsContainerSelect');
  if (!select) return;
  const names = [...deployments.map(d => d.container), 'vllm-litellm'];
  const current = Array.from(select.options).map(o => o.value).join('|');
  if (current === names.join('|')) return;
  const selected = select.value;
  select.replaceChildren(...names.map(n => {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    return opt;
  }));
  if (names.includes(selected)) select.value = selected;
}

function openLogsFor(container) {
  const select = document.getElementById('logsContainerSelect');
  if (select) {
    if (![...select.options].some(o => o.value === container)) {
      const opt = document.createElement('option');
      opt.value = opt.textContent = container;
      select.appendChild(opt);
    }
    select.value = container;
  }
  switchTab('tab-logs');
  document.getElementById('tab-logs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Fetch GPU Telemetry
async function refreshGpuStatus() {
  try {
    const res = await fetch(API.gpuStatus);
    if (!res.ok) return;
    const data = await res.json();
    state.gpus = data.gpus || [];
    renderGpuGrid(state.gpus);
    updateClusterMetrics(state.gpus);
  } catch (err) {
    console.error('Lỗi nạp telemetry GPU:', err);
  }
}

// Update Bento Cluster Metrics
function updateClusterMetrics(gpus) {
  if (!gpus || gpus.length === 0) return;
  let totalUsedMb = 0;
  let totalCapMb = 0;

  gpus.forEach(g => {
    totalUsedMb += g.memory_used_mb || 0;
    totalCapMb += g.memory_total_mb || 24576;
  });

  const usedGb = (totalUsedMb / 1024).toFixed(1);
  const totalGb = Math.round(totalCapMb / 1024);
  const percent = Math.round((totalUsedMb / totalCapMb) * 100);

  const bentoUsage = document.getElementById('bentoVramUsage');
  const bentoPercent = document.getElementById('bentoVramPercent');
  const bentoTitle = document.getElementById('bentoVramTitle');
  const bentoSub = document.getElementById('bentoVramSub');
  const rackTitle = document.getElementById('gpuRackTitle');

  if (bentoUsage) bentoUsage.textContent = `${usedGb} / ${totalGb} GB`;
  if (bentoPercent) bentoPercent.textContent = `${percent}%`;
  if (bentoTitle) bentoTitle.textContent = `Tổng VRAM Cụm (${gpus.length}x GPU)`;
  if (bentoSub) bentoSub.textContent = `Khả dụng: ${(totalGb - parseFloat(usedGb)).toFixed(1)} GB đệm`;

  if (rackTitle) {
    rackTitle.textContent = `Cụm ${gpus.length}x GPU NVIDIA RTX 3090 (${totalGb} GB VRAM)`;
  }
}

// Render GPU Rack Cards
function renderGpuGrid(gpus) {
  const container = document.getElementById('gpuGrid');
  if (!container) return;
  container.replaceChildren();

  gpus.forEach((gpu) => {
    const gpuUuidLower = (gpu.uuid || '').toLowerCase();
    const onGpu = state.deployments.filter(d =>
      d.running && (d.gpu_uuids || []).some(u => u.toLowerCase() === gpuUuidLower)
    );
    const isWorker = onGpu.length > 0;
    const isOtherBusy = gpu.memory_used_mb > 1500 && !isWorker;

    const card = document.createElement('div');
    card.className = `gpu-card ${isWorker ? 'active-worker' : ''}`;

    let barColor = 'fill-cyan';
    if (gpu.memory_percent > 85) barColor = 'fill-rose';
    else if (gpu.memory_percent > 65) barColor = 'fill-amber';
    else if (gpu.memory_percent > 25) barColor = 'fill-cyan';
    else barColor = 'fill-emerald';

    let badgeClass = 'badge-emerald';
    let badgeText = 'Rảnh';
    if (isWorker) {
      badgeClass = 'badge-cyan';
      badgeText = `${onGpu.length} dịch vụ`;
    } else if (isOtherBusy) {
      badgeClass = 'badge-amber';
      badgeText = 'Tiến trình khác';
    }

    const header = document.createElement('div');
    header.className = 'gpu-header';

    const nameGroup = document.createElement('div');
    nameGroup.className = 'gpu-name-group';
    const title = document.createElement('h4');
    title.innerHTML = `<span>GPU ${gpu.index}: RTX 3090</span>`;
    const uuid = document.createElement('div');
    uuid.className = 'gpu-uuid';
    uuid.textContent = gpu.uuid ? `${gpu.uuid.substring(0, 18)}...` : 'N/A';
    nameGroup.appendChild(title);
    nameGroup.appendChild(uuid);

    const badge = document.createElement('span');
    badge.className = `badge ${badgeClass}`;
    badge.innerHTML = isWorker ? `<span class="dot-pulse"></span> ${badgeText}` : badgeText;

    header.appendChild(nameGroup);
    header.appendChild(badge);

    // VRAM Bar
    const barGroup = document.createElement('div');
    barGroup.className = 'metric-bar-group';
    const barHeader = document.createElement('div');
    barHeader.className = 'metric-bar-header';
    barHeader.innerHTML = `<span>VRAM (${gpu.memory_percent}%)</span><span><b>${(gpu.memory_used_mb / 1024).toFixed(1)} GB</b> / ${Math.round(gpu.memory_total_mb / 1024)} GB</span>`;

    const barTrack = document.createElement('div');
    barTrack.className = 'metric-bar-track';
    const barFill = document.createElement('div');
    barFill.className = `metric-bar-fill ${barColor}`;
    barFill.style.width = `${Math.min(gpu.memory_percent, 100)}%`;
    barTrack.appendChild(barFill);

    barGroup.appendChild(barHeader);
    barGroup.appendChild(barTrack);

    // Stats Row (Nhiệt độ, Công suất, Tải GPU & Quạt)
    let tempColor = 'var(--text-main)';
    if (gpu.temperature_c >= 82) tempColor = 'var(--status-rose)';
    else if (gpu.temperature_c >= 70) tempColor = 'var(--status-amber)';
    else tempColor = 'var(--status-emerald)';

    const statsRow = document.createElement('div');
    statsRow.className = 'gpu-stats-row';
    statsRow.innerHTML = `
      <div class="gpu-stat-item">
        <div class="stat-label">Nhiệt độ</div>
        <div class="stat-val" style="color: ${tempColor};">${gpu.temperature_c}°C</div>
      </div>
      <div class="gpu-stat-item">
        <div class="stat-label">Công suất</div>
        <div class="stat-val">${Math.round(gpu.power_draw_w)}W</div>
      </div>
      <div class="gpu-stat-item">
        <div class="stat-label">Tải GPU</div>
        <div class="stat-val">${gpu.utilization_percent}% <span style="font-size: 0.68rem; color: var(--text-dim); font-weight: normal;">(${gpu.fan_percent || 0}% Fan)</span></div>
      </div>
    `;

    card.appendChild(header);
    card.appendChild(barGroup);
    card.appendChild(statsRow);

    if (isWorker) {
      const tenants = document.createElement('div');
      tenants.className = 'gpu-tenants';
      tenants.innerHTML = onGpu.map(d => {
        const share = d.gpu_memory_utilization ? ` ${Math.round(d.gpu_memory_utilization * 100)}%` : '';
        return `<span class="tenant-chip" title="${escapeHtml(d.model_id)}">${escapeHtml(d.container)}<b>${share}</b></span>`;
      }).join('');
      card.appendChild(tenants);
    }

    container.appendChild(card);
  });
}

// Fetch Instance & Container Status
async function refreshInstanceStatus() {
  try {
    const res = await fetch(API.instanceStatus);
    if (!res.ok) return;
    const data = await res.json();
    state.instance = data;
    state.currentModel = data.config?.model_id || 'Qwen/Qwen3.8-27B-FP8';

    const bentoCtxBadge = document.getElementById('bentoCtxBadge');
    const bentoCtxVal = document.getElementById('bentoCtxVal');

    if (data.config?.max_model_len) {
      const len = data.config.max_model_len;
      if (bentoCtxBadge) bentoCtxBadge.textContent = `${Math.round(len / 1024)}K Context`;
      if (bentoCtxVal) bentoCtxVal.textContent = `${len.toLocaleString('vi-VN')} Tokens`;
    }
  } catch (err) {
    console.error('Lỗi nạp trạng thái container:', err);
  }
}

// Fetch Local Models Catalog
async function refreshLocalModels() {
  try {
    const res = await fetch(API.modelsLocal);
    if (!res.ok) return;
    const data = await res.json();
    state.models = data.models || [];
    renderModelsTable(state.models);
  } catch (err) {
    console.error('Lỗi nạp danh mục model:', err);
  }
}

function modelRowState(m) {
  if (m.is_active) return 'running';
  if (m.weights_state && m.weights_state !== 'ready') return 'broken';
  return 'ready';
}

const MODEL_STATE_ORDER = { running: 0, ready: 1, broken: 2 };

function renderModelsTable(models) {
  const countBadge = document.getElementById('tabCountModels');
  if (countBadge) countBadge.textContent = models.length;

  const counts = { all: models.length, running: 0, ready: 0, broken: 0 };
  models.forEach(m => counts[modelRowState(m)]++);
  const setCount = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
  setCount('modelCountAll', counts.all);
  setCount('modelCountRunning', counts.running);
  setCount('modelCountReady', counts.ready);
  setCount('modelCountBroken', counts.broken);

  const totalGb = models.reduce((sum, m) => sum + (m.size_gb || 0), 0);
  const summary = document.getElementById('modelsSummary');
  if (summary) {
    summary.textContent = `${models.length} mô hình · ${totalGb.toFixed(1)} GB trên đĩa · ${counts.running} đang được container vLLM phục vụ`;
  }

  const tbody = document.getElementById('modelsTableBody');
  if (!tbody) return;
  tbody.replaceChildren();

  if (models.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="6" class="table-empty">Không tìm thấy mô hình nào trong cache local. Dùng "Thêm mô hình" để nhập hoặc tải về.</td>';
    tbody.appendChild(tr);
    return;
  }

  const sorted = [...models].sort((a, b) =>
    MODEL_STATE_ORDER[modelRowState(a)] - MODEL_STATE_ORDER[modelRowState(b)] ||
    a.repo_name.localeCompare(b.repo_name)
  );

  sorted.forEach((m) => {
    const rowState = modelRowState(m);
    const tr = document.createElement('tr');
    tr.dataset.state = rowState;
    if (rowState === 'running') tr.classList.add('row-running');

    const tagsHtml = m.tags.map(t => {
      let colorClass = 'badge-cyan';
      if (t === 'Vision-Language' || t === 'OCR') colorClass = 'badge-amber';
      else if (['FP8', 'AWQ', 'INT4', 'FP4'].includes(t)) colorClass = 'badge-green';
      return `<span class="badge badge-tag ${colorClass}">${escapeHtml(t)}</span>`;
    }).join(' ');

    const safeModelId = escapeHtml(m.model_id);
    const safeRepoName = escapeHtml(m.repo_name);
    const safeParam = escapeHtml(m.param_size);
    const deps = m.deployments || [];

    let statusHtml;
    if (deps.length) {
      statusHtml = deps.map(d => {
        const h = deploymentHealth(d);
        return `<button type="button" class="serving-chip ${h.cls}" data-container="${escapeHtml(d.container)}" title="${escapeHtml(h.label)} · route: ${escapeHtml((d.litellm_routes || []).join(', ') || 'không có')}">
          <span class="status-dot ${h.cls}" aria-hidden="true"></span>${escapeHtml(d.container)}${d.is_primary ? ' <em>chính</em>' : ''}
        </button>`;
      }).join('');
    } else if (rowState === 'broken') {
      statusHtml = `<span class="model-state broken">${m.weights_state === 'incomplete' ? 'Tải dở dang' : 'Chưa có trọng số'}</span>`;
    } else {
      statusHtml = '<span class="model-state ready">Sẵn sàng nạp</span>';
    }

    const deleteBtn = `
      <button class="btn btn-danger btn-sm btn-delete-model" title="Xóa cache mô hình khỏi ổ cứng">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 3px;">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>Xóa cache
      </button>`;

    let actionsHtml;
    if (deps.length) {
      actionsHtml = `<button class="btn btn-secondary btn-sm" data-container="${escapeHtml(deps[0].container)}">Cấu hình</button>${deleteBtn}`;
    } else if (rowState === 'broken') {
      actionsHtml = `<button class="btn btn-secondary btn-sm btn-redownload">Tải lại</button>${deleteBtn}`;
    } else {
      actionsHtml = deleteBtn;
    }

    tr.innerHTML = `
      <td>
        ${deps.length
          ? `<button type="button" class="model-name model-open" data-container="${escapeHtml(deps[0].container)}" title="Xem cấu hình triển khai">${safeRepoName}</button>`
          : `<div class="model-name">${safeRepoName}</div>`}
        <div class="model-id">${safeModelId}</div>
      </td>
      <td><div class="model-status">${statusHtml}</div></td>
      <td><span class="model-param">${safeParam}</span></td>
      <td class="${m.size_gb ? '' : 'muted'}">${m.size_gb} GB</td>
      <td><div class="tag-row">${tagsHtml}</div></td>
      <td class="col-actions"><div class="row-actions">${actionsHtml}</div></td>
    `;

    const runningContainers = deps.filter(d => d.running).map(d => d.container);
    tr.querySelector('.btn-delete-model')?.addEventListener('click', () => deleteModel(m.model_id, m.repo_name, m.size_gb, runningContainers));
    tr.querySelector('.btn-redownload')?.addEventListener('click', () => redownloadModel(m.model_id));
    tr.querySelectorAll('[data-container]').forEach(el => {
      el.addEventListener('click', () => openDeployDrawer(el.dataset.container));
    });
    tbody.appendChild(tr);
  });

  filterModelsTable();
}

async function redownloadModel(modelId) {
  if (!confirm(`Tải lại '${modelId}' từ HuggingFace? Máy chủ cần có kết nối mạng ra ngoài.`)) return;
  try {
    const res = await fetch(API.modelDownload, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: modelId })
    });
    const data = await res.json();
    showToast(res.ok ? (data.message || `Đang tải ${modelId}`) : (data.detail || 'Không thể bắt đầu tải'), res.ok ? 'info' : 'error');
  } catch (err) {
    showToast('Lỗi gửi yêu cầu tải: ' + err.message, 'error');
  }
}

// Model Deletion
async function deleteModel(modelId, repoName, sizeGb, runningContainers = []) {
  if (runningContainers.length > 0) {
    showToast(`Không thể xóa: Container '${runningContainers.join(', ')}' đang chạy mô hình này. Vui lòng dừng container trước khi xóa cache.`, 'warning');
    return;
  }

  if (!confirm(`Xác nhận xóa vĩnh viễn cache mô hình '${repoName}' (${sizeGb} GB) khỏi ổ cứng máy chủ để giải phóng dung lượng?`)) return;

  try {
    showToast(`Đang xóa cache mô hình ${repoName}...`, 'info');
    const res = await fetch(API.modelDelete, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: modelId })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message, 'success');
      refreshLocalModels();
      refreshDeployments();
      refreshChatModels();
    } else {
      showToast(data.detail || 'Lỗi khi xóa mô hình', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối khi xóa mô hình: ' + err.message, 'error');
  }
}

// Add Model Modal (Import & Download)
function openAddModelModal() {
  const modal = document.getElementById('addModelModal');
  if (modal) modal.classList.add('active');
}

function closeAddModelModal() {
  const modal = document.getElementById('addModelModal');
  if (modal) modal.classList.remove('active');
}

function switchAddSubtab(tab) {
  const btnImport = document.getElementById('subtabBtnImport');
  const btnDownload = document.getElementById('subtabBtnDownload');
  const formImport = document.getElementById('importModelForm');
  const formDownload = document.getElementById('downloadModelForm');

  if (tab === 'import') {
    btnImport?.classList.add('active');
    btnDownload?.classList.remove('active');
    if (formImport) formImport.style.display = 'block';
    if (formDownload) formDownload.style.display = 'none';
  } else {
    btnDownload?.classList.add('active');
    btnImport?.classList.remove('active');
    if (formDownload) formDownload.style.display = 'block';
    if (formImport) formImport.style.display = 'none';
  }
}

async function submitImportModel(e) {
  e.preventDefault();
  const modelId = document.getElementById('importModelId')?.value.trim();
  const localPath = document.getElementById('importLocalPath')?.value.trim();
  if (!modelId || !localPath) return;

  closeAddModelModal();
  showToast(`Đang import mô hình ${modelId}...`, 'info');

  try {
    const res = await fetch(API.modelImport, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: modelId, local_path: localPath })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message, 'success');
      refreshLocalModels();
    } else {
      showToast(data.detail || 'Lỗi import mô hình', 'error');
    }
  } catch (err) {
    showToast('Lỗi gửi yêu cầu import: ' + err.message, 'error');
  }
}

async function submitDownloadModel(e) {
  e.preventDefault();
  const modelId = document.getElementById('downloadModelId')?.value.trim();
  if (!modelId) return;

  closeAddModelModal();
  showToast(`Đang khởi chạy tải mô hình ${modelId}...`, 'info');

  try {
    const res = await fetch(API.modelDownload, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: modelId })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message, 'success');
      let count = 0;
      const timer = setInterval(() => {
        refreshLocalModels();
        count++;
        if (count > 12) clearInterval(timer);
      }, 10000);
    } else {
      showToast(data.detail || 'Lỗi tải mô hình', 'error');
    }
  } catch (err) {
    showToast('Lỗi gửi yêu cầu tải: ' + err.message, 'error');
  }
}

// LoRA Adapters Management
async function refreshLoraAdapters() {
  try {
    const res = await fetch(API.loraList);
    if (!res.ok) return;
    const data = await res.json();
    renderLoraTable(data.models || []);
  } catch (err) {
    console.error('Lỗi nạp LoRA list:', err);
  }
}

function renderLoraTable(models) {
  const tbody = document.getElementById('loraTableBody');
  if (!tbody) return;
  tbody.replaceChildren();

  const adapters = models.filter(m => m.id && m.parent_model);
  const countBadge = document.getElementById('tabCountLora');
  if (countBadge) countBadge.textContent = adapters.length;

  if (adapters.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="4" style="text-align: center; color: var(--text-dim); padding: 1.5rem;">Chưa có LoRA adapter nào được nạp động. vLLM đang phục vụ mô hình gốc.</td>';
    tbody.appendChild(tr);
    return;
  }

  adapters.forEach((a) => {
    const tr = document.createElement('tr');
    const safeId = escapeHtml(a.id);
    const safeParent = escapeHtml(a.parent_model || 'Base');
    tr.innerHTML = `
      <td><b>${safeId}</b></td>
      <td><span class="badge badge-cyan">${safeParent}</span></td>
      <td><span class="badge badge-green">Active</span></td>
      <td style="text-align: right;">
        <button class="btn btn-danger btn-sm btn-unload" data-id="${safeId}">Gỡ Adapter (Rollback)</button>
      </td>
    `;
    const btn = tr.querySelector('.btn-unload');
    if (btn) {
      btn.addEventListener('click', () => unloadLora(a.id));
    }
    tbody.appendChild(tr);
  });
}

async function loadLoraPrompt() {
  const name = prompt('Nhập tên định danh LoRA (ví dụ: lora-cchc-hungyen):');
  if (!name) return;
  const path = prompt('Nhập đường dẫn thư mục LoRA Checkpoint (ví dụ: /home/cahy/code/unsloth/outputs/hungyen-lora):');
  if (!path) return;

  try {
    showToast('Đang nạp LoRA adapter...', 'info');
    const res = await fetch(API.loraLoad, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lora_name: name.trim(), lora_path: path.trim() })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message, 'success');
      refreshLoraAdapters();
      refreshChatModels();
    } else {
      showToast(data.error || 'Lỗi nạp LoRA', 'error');
    }
  } catch (err) {
    showToast('Lỗi gửi yêu cầu nạp LoRA: ' + err.message, 'error');
  }
}

async function unloadLora(name) {
  if (!confirm(`Xác nhận gỡ LoRA adapter '${name}' và khôi phục về mô hình gốc?`)) return;

  try {
    showToast('Đang gỡ LoRA adapter...', 'info');
    const res = await fetch(API.loraUnload, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lora_name: name })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message, 'success');
      refreshLoraAdapters();
      refreshChatModels();
    } else {
      showToast(data.error || 'Lỗi gỡ LoRA', 'error');
    }
  } catch (err) {
    showToast('Lỗi gửi yêu cầu gỡ LoRA: ' + err.message, 'error');
  }
}

// Live Logs Viewer
async function refreshLogs() {
  const viewer = document.getElementById('logsViewer');
  if (!viewer) return;

  try {
    const container = document.getElementById('logsContainerSelect')?.value || 'qwen';
    const res = await fetch(`${API.instanceLogs}?tail=200&container=${encodeURIComponent(container)}`);
    if (!res.ok) return;
    const data = await res.json();
    viewer.textContent = data.logs || 'Chưa có nhật ký ghi nhận.';
    viewer.scrollTop = viewer.scrollHeight;
  } catch (err) {
    viewer.textContent = 'Lỗi nạp nhật ký: ' + err.message;
  }
}

// Actions (Start / Stop / Restart)
async function handleContainerAction(action, target) {
  const actionName = (action === 'restart') ? 'khởi động lại' : (action === 'stop' ? 'dừng' : 'bật');
  if (!confirm(`Xác nhận ${actionName} dịch vụ ${target}?`)) return;

  try {
    showToast(`Đang thực hiện ${action} ${target}...`, 'info');
    const res = await fetch(API.instanceAction, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, target })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Thao tác ${action} hoàn tất`, 'success');
      setTimeout(() => { refreshDeployments(); refreshLocalModels(); }, 1600);
    }
  } catch (err) {
    showToast('Lỗi thực thi: ' + err.message, 'error');
  }
}

// Modal Switcher
function openSwitchModal(modelId) {
  const modal = document.getElementById('switchModal');
  const inputModel = document.getElementById('switchModelId');
  if (inputModel) inputModel.value = modelId;
  if (modal) modal.classList.add('active');
}

function closeSwitchModal() {
  const modal = document.getElementById('switchModal');
  if (modal) modal.classList.remove('active');
}

async function submitModelSwitch(e) {
  e.preventDefault();
  const modelId = document.getElementById('switchModelId').value.trim();
  const tpSize = parseInt(document.getElementById('switchTpSize').value);
  const memUtil = parseFloat(document.getElementById('switchMemUtil').value);
  const maxLen = parseInt(document.getElementById('switchMaxLen').value);

  const checkboxes = document.querySelectorAll('input[name="gpuSelect"]:checked');
  const gpuIndices = Array.from(checkboxes).map(cb => parseInt(cb.value));

  if (gpuIndices.length !== tpSize) {
    alert(`Số lượng GPU đã chọn (${gpuIndices.length}) phải bằng với Tensor Parallel Size (${tpSize}).`);
    return;
  }

  closeSwitchModal();
  showToast(`Đang chuyển sang mô hình ${modelId}...`, 'info');

  try {
    const res = await fetch(API.instanceSwitch, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: modelId,
        tensor_parallel_size: tpSize,
        gpu_indices: gpuIndices,
        gpu_memory_utilization: memUtil,
        max_model_len: maxLen,
        enable_prefix_caching: true,
        enable_lora: false
      })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message, 'success');
      let checkCount = 0;
      const logTimer = setInterval(() => {
        refreshLogs();
        refreshInstanceStatus();
        checkCount++;
        if (checkCount > 15) clearInterval(logTimer);
      }, 5000);
    } else {
      showToast(data.detail || 'Lỗi chuyển đổi mô hình', 'error');
    }
  } catch (err) {
    showToast('Lỗi gửi yêu cầu chuyển đổi: ' + err.message, 'error');
  }
}

// Model Selector for Live Smoke Test Chat
async function refreshChatModels() {
  const modelSelect = document.getElementById('chatModelSelect');
  if (!modelSelect) return;

  const target = document.getElementById('chatTargetSelect')?.value || 'vllm';
  const previousValue = modelSelect.value;

  try {
    const res = await fetch(`${API.testModels}?target=${encodeURIComponent(target)}`);
    if (!res.ok) return;
    const data = await res.json();
    const models = data.models || [];

    modelSelect.replaceChildren();

    if (models.length === 0) {
      const opt = document.createElement('option');
      opt.value = data.default || '';
      opt.textContent = data.default || 'Mô hình mặc định';
      modelSelect.appendChild(opt);
      return;
    }

    let hasSelected = false;
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      if (previousValue && m.id === previousValue) {
        opt.selected = true;
        hasSelected = true;
      } else if (!hasSelected && !previousValue && (m.id === data.default || m.id === 'Qwen/Qwen3.5-9B' || m.id === 'qwen-3.5-9b')) {
        opt.selected = true;
        hasSelected = true;
      }
      modelSelect.appendChild(opt);
    });

    if (!hasSelected && modelSelect.options.length > 0) {
      modelSelect.options[0].selected = true;
    }
  } catch (err) {
    console.error('Lỗi nạp danh sách model test:', err);
  }
}

// Live Smoke Test Chat Stream
async function handleSendChat() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text || state.isChatStreaming) return;

  input.value = '';
  state.isChatStreaming = true;

  const messagesDiv = document.getElementById('chatMessages');

  // Add User bubble
  const userBubble = document.createElement('div');
  userBubble.className = 'chat-bubble chat-user';
  userBubble.textContent = text;
  messagesDiv.appendChild(userBubble);

  // Add Assistant bubble placeholder
  const aiBubble = document.createElement('div');
  aiBubble.className = 'chat-bubble chat-assistant';
  aiBubble.textContent = '...';
  messagesDiv.appendChild(aiBubble);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;

  state.chatHistory.push({ role: 'user', content: text });

  const ttftSpan = document.getElementById('metricTtft');
  const tpsSpan = document.getElementById('metricTps');
  const tokensSpan = document.getElementById('metricTokens');
  const latencySpan = document.getElementById('metricLatency');

  const temp = parseFloat(document.getElementById('paramTemp')?.value || '0.7');
  const maxTokens = parseInt(document.getElementById('paramMaxTokens')?.value || '512');
  const target = document.getElementById('chatTargetSelect')?.value || 'vllm';
  const model = document.getElementById('chatModelSelect')?.value || undefined;

  try {
    const response = await fetch(API.testChat, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: state.chatHistory,
        model: model,
        target: target,
        temperature: temp,
        max_tokens: maxTokens,
        stream: true
      })
    });

    if (!response.ok) {
      const err = await response.text();
      aiBubble.textContent = `Lỗi: ${err}`;
      state.isChatStreaming = false;
      return;
    }

    aiBubble.textContent = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const raw = line.substring(6).trim();
          if (raw === '[DONE]') break;
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) {
              aiBubble.textContent += `\n[Lỗi: ${parsed.error}]`;
            } else if (parsed.meta) {
              if (ttftSpan) ttftSpan.textContent = `${parsed.ttft_ms} ms`;
              if (tpsSpan) tpsSpan.textContent = `${parsed.tokens_per_second} t/s`;
              if (tokensSpan) tokensSpan.textContent = `${parsed.total_tokens} tokens`;
              if (latencySpan) latencySpan.textContent = `${parsed.total_time_s} s`;
            } else if (parsed.delta) {
              accumulated += parsed.delta;
              aiBubble.textContent = accumulated;
              messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }
          } catch (e) {
            // ignore non-json stream frames
          }
        }
      }
    }

    state.chatHistory.push({ role: 'assistant', content: accumulated });
  } catch (err) {
    aiBubble.textContent = `Lỗi kết nối: ${err.message}`;
  } finally {
    state.isChatStreaming = false;
  }
}

// Helper to safely extract preview text from prompt/messages (supports text, arrays, multimodal vision payloads)
function extractPromptPreview(messages, maxLength = 75) {
  if (!messages) return '';
  try {
    if (typeof messages === 'string') {
      return messages.substring(0, maxLength);
    }
    if (Array.isArray(messages) && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (!lastMsg) return '';
      const content = lastMsg.content;
      if (typeof content === 'string') {
        return content.substring(0, maxLength);
      }
      if (Array.isArray(content)) {
        // Vision / Multimodal format: array of {type, text, image_url}
        const textPart = content.find(p => p && (p.type === 'text' || p.text));
        if (textPart && textPart.text) {
          return String(textPart.text).substring(0, maxLength);
        }
        return '[Hình ảnh / Multimodal Payload]';
      }
      if (content && typeof content === 'object') {
        return JSON.stringify(content).substring(0, maxLength);
      }
      return String(content || '').substring(0, maxLength);
    }
    if (typeof messages === 'object') {
      return JSON.stringify(messages).substring(0, maxLength);
    }
  } catch (e) {
    return '';
  }
  return '';
}

// Helper to safely extract response preview
function extractResponsePreview(response, maxLength = 85) {
  if (!response) return '';
  try {
    if (typeof response === 'string') {
      return response.substring(0, maxLength);
    }
    if (typeof response === 'object') {
      return JSON.stringify(response).substring(0, maxLength);
    }
    return String(response).substring(0, maxLength);
  } catch (e) {
    return '';
  }
}

// Clean messages for modal view (truncate giant base64 images so UI doesn't lag)
function sanitizeMessagesForDisplay(messages) {
  if (!messages) return 'None';
  try {
    const cloned = JSON.parse(JSON.stringify(messages));
    if (Array.isArray(cloned)) {
      cloned.forEach(msg => {
        if (Array.isArray(msg.content)) {
          msg.content.forEach(part => {
            if (part && part.image_url && typeof part.image_url.url === 'string') {
              if (part.image_url.url.startsWith('data:image')) {
                const len = part.image_url.url.length;
                part.image_url.url = `${part.image_url.url.substring(0, 32)}... [Base64 Image Data - ${Math.round(len / 1024)} KB]`;
              }
            }
          });
        }
      });
    }
    return JSON.stringify(cloned, null, 2);
  } catch (e) {
    return typeof messages === 'string' ? messages : String(messages);
  }
}

let searchDebounceTimer = null;
function debounceAuditSearch() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    const input = document.getElementById('auditSearchInput');
    state.auditSearch = input ? input.value.trim() : '';
    state.auditPage = 1;
    refreshAuditLogs();
  }, 350);
}

function setAuditStatusFilter(status) {
  state.auditStatus = status;
  state.auditPage = 1;
  document.querySelectorAll('.filter-chip[data-status]').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.status === status);
  });
  const chipAll = document.getElementById('chipAuditAll');
  const chipErr = document.getElementById('chipAuditError');
  const chipSuc = document.getElementById('chipAuditSuccess');
  if (chipAll) chipAll.classList.toggle('active', status === 'all');
  if (chipErr) chipErr.classList.toggle('active', status === 'error');
  if (chipSuc) chipSuc.classList.toggle('active', status === 'success');
  refreshAuditLogs();
}

function toggleAuditAutoRefresh() {
  const toggle = document.getElementById('auditAutoRefreshToggle');
  if (!toggle) return;

  if (toggle.checked) {
    if (state.auditAutoRefreshTimer) clearInterval(state.auditAutoRefreshTimer);
    state.auditAutoRefreshTimer = setInterval(() => {
      const activeTab = document.querySelector('.tab-pane.active');
      if (activeTab && activeTab.id === 'tab-audit') {
        refreshAuditLogs(true);
      }
    }, 3000);
    showToast('Đã bật tự động cập nhật log mỗi 3s', 'info');
  } else {
    if (state.auditAutoRefreshTimer) {
      clearInterval(state.auditAutoRefreshTimer);
      state.auditAutoRefreshTimer = null;
    }
  }
}

async function refreshAuditLogs(isSilent = false) {
  const tableBody = document.getElementById('auditTableBody');
  if (!tableBody) return;

  const modelSelect = document.getElementById('auditModelFilter');
  const selectedModel = modelSelect ? modelSelect.value : 'all';

  const params = new URLSearchParams({
    limit: String(state.auditPageSize),
    offset: String((state.auditPage - 1) * state.auditPageSize),
    status: state.auditStatus || 'all'
  });
  if (selectedModel && selectedModel !== 'all') params.append('model', selectedModel);
  if (state.auditSearch) params.append('search', state.auditSearch);

  try {
    const res = await fetch(`${API.auditLogs}?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.auditLogs = data.logs || [];

    // Filtered set shrank (cleared or rotated log): step back to the last page that exists
    const totalFiltered = data.total_filtered ?? state.auditLogs.length;
    const lastPage = Math.max(1, Math.ceil(totalFiltered / state.auditPageSize));
    if (state.auditPage > lastPage) {
      state.auditPage = lastPage;
      return refreshAuditLogs(isSilent);
    }
    renderAuditPager(totalFiltered);

    // Update stats counters
    const stats = data.stats || {};
    const totalEl = document.getElementById('auditMetricTotal');
    const succEl = document.getElementById('auditMetricSuccess');
    const errEl = document.getElementById('auditMetricError');
    const errBadgeEl = document.getElementById('auditMetricErrorBadge');
    const errRateEl = document.getElementById('auditMetricErrorRate');
    const latEl = document.getElementById('auditMetricLatency');
    const tabCountAuditErr = document.getElementById('tabCountAuditErr');

    if (totalEl) totalEl.textContent = (stats.total || 0).toLocaleString('vi-VN');
    if (succEl) succEl.textContent = (stats.success || 0).toLocaleString('vi-VN');
    if (errEl) errEl.textContent = (stats.error || 0).toLocaleString('vi-VN');
    if (errBadgeEl) errBadgeEl.textContent = `${stats.error || 0} Lỗi Ghi Nhận`;
    if (errRateEl) errRateEl.textContent = `Tỉ lệ lỗi: ${stats.error_rate || 0}%`;

    const avgLat = stats.avg_latency_ms || 0;
    if (latEl) {
      latEl.textContent = avgLat >= 1000 ? `${(avgLat / 1000).toFixed(1)} s` : `${Math.round(avgLat)} ms`;
    }

    if (tabCountAuditErr) {
      const errCount = stats.error || 0;
      tabCountAuditErr.textContent = `${errCount} Lỗi`;
      tabCountAuditErr.className = errCount > 0 ? 'tab-count badge-rose-subtle' : 'tab-count';
    }

    // Populate model filter dropdown
    if (modelSelect && data.models && data.models.length > 0) {
      const curVal = modelSelect.value;
      const opts = ['<option value="all">Tất cả Models</option>'];
      data.models.forEach(m => {
        const isSel = (m === curVal) ? 'selected' : '';
        opts.push(`<option value="${escapeHtml(m)}" ${isSel}>${escapeHtml(m)}</option>`);
      });
      modelSelect.innerHTML = opts.join('');
    }

    // Render table
    if (state.auditLogs.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center text-muted" style="padding: 32px;">
            Không có bản ghi nhật ký nào phù hợp với bộ lọc hiện tại.
          </td>
        </tr>
      `;
      return;
    }

    const rows = state.auditLogs.map(item => {
      const isErr = (item.status || '').toLowerCase() === 'error';
      const statusCode = item.status_code || (isErr ? 500 : 200);

      // Status badge
      let statusBadge = '';
      if (isErr) {
        const cat = (item.error && item.error.category) ? item.error.category : 'ERROR';
        statusBadge = `<span class="badge badge-rose font-mono">HTTP ${statusCode} [${escapeHtml(cat)}]</span>`;
      } else {
        statusBadge = `<span class="badge badge-emerald font-mono">HTTP 200 OK</span>`;
      }

      // Format time (show HH:MM:SS & short date)
      let timeStr = item.timestamp || '';
      try {
        const d = new Date(item.timestamp);
        timeStr = d.toLocaleTimeString('vi-VN', { hour12: false }) + ' ' + d.toLocaleDateString('vi-VN', { month: 'numeric', day: 'numeric' });
      } catch (e) {}

      // Prompt preview (safe for text, arrays, multimodal vision payloads)
      const promptSnippet = extractPromptPreview(item.messages, 70);

      // Root cause or response preview
      let causeHtml = '';
      if (isErr && item.error) {
        const cause = item.error.cause || item.error.message || 'Lỗi xử lý yêu cầu';
        causeHtml = `
          <div class="audit-cause-inline error">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0; margin-top: 1px;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <div>
              <strong style="color: #fb7185;">${escapeHtml(cause)}</strong>
              ${promptSnippet ? `<div class="text-dim text-xs" style="margin-top: 2px;">Prompt: "${escapeHtml(promptSnippet)}..."</div>` : ''}
            </div>
          </div>
        `;
      } else {
        const respPreview = extractResponsePreview(item.response, 85);
        causeHtml = `
          <div class="audit-cause-inline success">
            <div>
              <span class="text-main">${escapeHtml(respPreview || 'Thành công')}${respPreview.length >= 85 ? '...' : ''}</span>
              ${promptSnippet ? `<div class="text-dim text-xs" style="margin-top: 2px;">Prompt: "${escapeHtml(promptSnippet)}..."</div>` : ''}
            </div>
          </div>
        `;
      }

      const totalTokens = (item.usage && typeof item.usage.total_tokens === 'number') ? `${item.usage.total_tokens.toLocaleString('vi-VN')} t` : '-';
      let latencyFormatted = '-';
      if (typeof item.latency_ms === 'number') {
        if (item.latency_ms >= 1000) {
          latencyFormatted = `${(item.latency_ms / 1000).toFixed(1)} s`;
        } else {
          latencyFormatted = `${Math.round(item.latency_ms)} ms`;
        }
      }

      return `
        <tr style="${isErr ? 'background: rgba(244, 63, 94, 0.04);' : ''}">
          <td class="font-mono text-xs text-muted">${escapeHtml(timeStr)}</td>
          <td>${statusBadge}</td>
          <td class="font-mono text-xs text-cyan" style="word-break: break-all;">${escapeHtml(item.model || 'unknown')}</td>
          <td class="font-mono text-xs text-muted">${latencyFormatted}</td>
          <td class="font-mono text-xs text-muted">${totalTokens}</td>
          <td>${causeHtml}</td>
          <td style="text-align: right;">
            <button class="btn btn-secondary btn-sm" onclick="openAuditDetailModal('${escapeHtml(item.id)}')">Chi Tiết</button>
          </td>
        </tr>
      `;
    }).join('');

    tableBody.innerHTML = rows;
  } catch (err) {
    if (!isSilent) showToast(`Không thể nạp nhật ký audit: ${err.message}`, 'error');
  }
}

function openAuditDetailModal(reqId) {
  const item = state.auditLogs.find(l => String(l.id) === String(reqId));
  if (!item) return;

  const modal = document.getElementById('auditDetailModal');
  const titleEl = document.getElementById('auditDetailTitle');
  const badgeEl = document.getElementById('auditDetailStatusBadge');
  const causeBox = document.getElementById('auditErrorCauseBox');
  const causeText = document.getElementById('auditErrorCauseText');
  const remText = document.getElementById('auditRemediationText');
  const timeEl = document.getElementById('auditDetailTimestamp');
  const modelEl = document.getElementById('auditDetailModel');
  const latEl = document.getElementById('auditDetailLatency');
  const usageEl = document.getElementById('auditDetailUsage');
  const msgEl = document.getElementById('auditDetailMessages');
  const respEl = document.getElementById('auditDetailResponse');
  const respSec = document.getElementById('auditDetailResponseSection');
  const rawErrEl = document.getElementById('auditDetailRawError');
  const rawErrSec = document.getElementById('auditDetailRawErrorSection');

  if (titleEl) titleEl.textContent = `Yêu Cầu #${item.id || ''}`;
  if (timeEl) timeEl.textContent = item.timestamp || '';
  if (modelEl) modelEl.textContent = item.model || 'unknown';
  if (latEl) latEl.textContent = item.latency_ms ? `${item.latency_ms} ms` : 'N/A';

  const usage = item.usage || {};
  if (usageEl) {
    usageEl.textContent = `Prompt: ${usage.prompt_tokens || 0} | Completion: ${usage.completion_tokens || 0} | Tổng: ${usage.total_tokens || 0}`;
  }

  // Format messages safely
  if (msgEl) {
    msgEl.textContent = sanitizeMessagesForDisplay(item.messages);
  }

  const isErr = (item.status || '').toLowerCase() === 'error';
  if (isErr) {
    if (badgeEl) {
      badgeEl.className = 'badge badge-rose';
      badgeEl.textContent = `HTTP ${item.status_code || 500} [${item.error?.category || 'ERROR'}]`;
    }

    if (causeBox) causeBox.style.display = 'block';
    if (causeText) causeText.textContent = item.error?.cause || 'Phát hiện lỗi không xác định trong quá trình suy luận.';
    if (remText) remText.textContent = item.error?.suggested_action || 'Kiểm tra terminal log của vLLM container hoặc thử lại với tham số thấp hơn.';

    if (rawErrSec) rawErrSec.style.display = 'block';
    if (rawErrEl) rawErrEl.textContent = item.error?.message || 'No technical exception logged.';

    if (respSec) respSec.style.display = 'none';
  } else {
    if (badgeEl) {
      badgeEl.className = 'badge badge-emerald';
      badgeEl.textContent = 'HTTP 200 OK (Thành Công)';
    }

    if (causeBox) causeBox.style.display = 'none';
    if (rawErrSec) rawErrSec.style.display = 'none';

    if (respSec) respSec.style.display = 'block';
    if (respEl) respEl.textContent = item.response || '(Không có nội dung trả về hoặc là dạng streaming)';
  }

  if (modal) modal.classList.add('active');
}

function closeAuditDetailModal() {
  const modal = document.getElementById('auditDetailModal');
  if (modal) modal.classList.remove('active');
}

function exportAuditLogs(format = 'json') {
  const modelSelect = document.getElementById('auditModelFilter');
  const selectedModel = modelSelect ? modelSelect.value : 'all';

  const params = new URLSearchParams({
    format: format,
    status: state.auditStatus || 'all'
  });
  if (selectedModel && selectedModel !== 'all') params.append('model', selectedModel);

  showToast(`Đang xuất dữ liệu ra file ${format.toUpperCase()}...`, 'info');
  window.location.href = `/api/audit/export?${params.toString()}`;
}

async function clearAuditLogs() {
  if (!confirm('Bạn có chắc chắn muốn xóa toàn bộ lịch sử Audit Log không? Hành động này không thể hoàn tác.')) return;
  try {
    const res = await fetch(API.auditClear, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Đã xóa toàn bộ lịch sử audit log', 'success');
      refreshAuditLogs();
    } else {
      showToast(`Lỗi khi xóa log: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`Lỗi: ${err.message}`, 'error');
  }
}

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  refreshGpuStatus();
  refreshInstanceStatus();
  refreshDeployments();
  refreshLocalModels();
  refreshLoraAdapters();
  refreshLogs();
  refreshAuditLogs();
  refreshChatModels();

  // 3.5s Polling for real-time telemetry
  setInterval(() => {
    if (document.hidden) return;
    refreshGpuStatus();
    refreshInstanceStatus();
    refreshDeployments();
  }, 3500);

  // Model catalog status follows container state, but the disk scan is heavier
  setInterval(() => {
    if (!document.hidden) refreshLocalModels();
  }, 15000);

  // Bind Form Switcher
  const switchForm = document.getElementById('switchForm');
  if (switchForm) {
    switchForm.addEventListener('submit', submitModelSwitch);
  }
});

// ---- Deployment detail drawer
function parseVllmArgs(args) {
  const out = [];
  (args || []).forEach(a => {
    if (a.startsWith('--')) {
      const [flag, ...rest] = a.split('=');
      out.push({ flag, value: rest.join('=') });
    } else if (out.length) {
      const last = out[out.length - 1];
      last.value = last.value ? `${last.value} ${a}` : a;
    } else {
      out.push({ flag: '', value: a });
    }
  });
  return out;
}

function kvRows(rows) {
  return rows.map(([k, v]) => `
    <div class="kv-row"><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`).join('');
}

function openDeployDrawer(container) {
  const d = state.deployments.find(x => x.container === container);
  if (!d) {
    showToast(`Chưa có thông tin container ${container}`, 'error');
    return;
  }
  const h = deploymentHealth(d);
  const flags = parseVllmArgs(d.args);
  const flagValue = f => flags.find(x => x.flag === f)?.value;
  const gpuRows = (d.gpu_uuids || []).map(u => {
    const gpu = state.gpus.find(g => (g.uuid || '').toLowerCase() === u.toLowerCase());
    return `<div class="gpu-line"><span class="gpu-chip">${gpu ? `GPU ${gpu.index}` : 'GPU ?'}</span><code>${escapeHtml(u)}</code></div>`;
  }).join('') || '<span class="muted">Không giới hạn GPU</span>';
  const vramGb = d.gpu_memory_utilization ? (d.gpu_memory_utilization * 24 * (d.tensor_parallel_size || 1)).toFixed(1) : null;
  const routes = d.litellm_routes || [];
  const mono = v => `<code>${escapeHtml(v ?? '--')}</code>`;
  const serveCmd = `vllm serve ${(d.args || []).map(a => /\s/.test(a) ? `'${a}'` : a).join(' ')}`;

  document.getElementById('drawerKicker').textContent = `${d.container} · ${ROLE_LABELS[d.role] || d.role}${d.is_primary ? ' · chính' : ''}`;
  document.getElementById('drawerTitle').textContent = d.model_id;

  document.getElementById('drawerBody').innerHTML = `
    <div class="drawer-status ${h.cls}">
      <span class="status-dot ${h.cls}" aria-hidden="true"></span>
      <strong>${escapeHtml(h.label)}</strong>
      ${d.running ? `<span>chạy ${escapeHtml(formatUptime(d.started_at))}</span>` : ''}
    </div>

    <section class="drawer-section">
      <h4>Phục vụ</h4>
      <dl class="kv">${kvRows([
        ['Model', mono(d.model_id)],
        ['Served name', (d.served_names || []).map(n => `<code class="route-chip">${escapeHtml(n)}</code>`).join(' ')],
        ['Route LiteLLM', routes.length ? routes.map(r => `<code class="route-chip">${escapeHtml(r)}</code>`).join(' ') : '<span class="muted">Chưa khai báo trong litellm_config.yaml</span>'],
        ['Gọi trực tiếp', d.host_port ? mono(`http://<host>:${d.host_port}/v1`) : mono(`http://${d.service}:8000/v1 (mạng nội bộ docker)`)],
        ['Qua gateway', mono('http://<host>:4000/v1')]
      ])}</dl>
    </section>

    <section class="drawer-section">
      <h4>Tài nguyên GPU</h4>
      <dl class="kv">${kvRows([
        ['GPU', gpuRows],
        ['Tensor parallel', mono(d.tensor_parallel_size)],
        ['GPU mem util', `${mono(d.gpu_memory_utilization || '--')}${vramGb ? ` <span class="muted">≈ ${vramGb} GB VRAM</span>` : ''}`],
        ['Max model len', mono(d.max_model_len ? `${d.max_model_len.toLocaleString('vi-VN')} tokens` : '--')],
        ['KV cache dtype', mono(flagValue('--kv-cache-dtype') || 'auto')],
        ['Max num seqs', mono(flagValue('--max-num-seqs') || 'mặc định')]
      ])}</dl>
    </section>

    <section class="drawer-section">
      <h4>Container</h4>
      <dl class="kv">${kvRows([
        ['Image', mono(d.image)],
        ['Compose service', mono(d.service)],
        ['Cổng host', mono(d.host_port ? `${d.host_port} → 8000` : 'không publish')],
        ['Restart policy', mono(d.restart_policy || '--')],
        ['IPC / SHM', mono(`${d.ipc_mode || '--'} / ${d.shm_size_gb} GB`)],
        ['Bắt đầu', mono(d.started_at ? new Date(d.started_at).toLocaleString('vi-VN') : '--')]
      ])}</dl>
    </section>

    <section class="drawer-section">
      <div class="drawer-section-head">
        <h4>Tham số vLLM <span class="muted">${flags.length}</span></h4>
        <button type="button" class="btn btn-secondary btn-sm" id="copyServeCmd">Sao chép lệnh</button>
      </div>
      <table class="args-table"><tbody>
        ${flags.map(f => `<tr><td>${escapeHtml(f.flag)}</td><td>${f.value ? escapeHtml(f.value) : '<span class="muted">bật</span>'}</td></tr>`).join('')}
      </tbody></table>
    </section>

    <section class="drawer-section">
      <h4>Biến môi trường <span class="muted">${Object.keys(d.env || {}).length}</span></h4>
      <table class="args-table"><tbody>
        ${Object.entries(d.env || {}).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('')}
      </tbody></table>
    </section>

    <section class="drawer-section">
      <h4>Volume</h4>
      <table class="args-table"><tbody>
        ${(d.mounts || []).map(m => `<tr><td>${escapeHtml(m.target)}</td><td>${escapeHtml(m.source)} <span class="muted">${m.rw ? 'rw' : 'ro'}</span></td></tr>`).join('') || '<tr><td colspan="2" class="muted">Không có</td></tr>'}
      </tbody></table>
    </section>

    <div class="drawer-actions">
      <button type="button" class="btn btn-secondary btn-sm" data-drawer-act="logs">Xem nhật ký</button>
      ${d.running
        ? '<button type="button" class="btn btn-secondary btn-sm" data-drawer-act="restart">Khởi động lại</button>'
        : '<button type="button" class="btn btn-primary btn-sm" data-drawer-act="start">Bật container</button>'}
    </div>
  `;

  document.getElementById('copyServeCmd')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(serveCmd);
      showToast('Đã sao chép lệnh vllm serve', 'success');
    } catch {
      showToast('Trình duyệt chặn clipboard (cần HTTPS)', 'error');
    }
  });
  document.querySelectorAll('[data-drawer-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.drawerAct;
      closeDeployDrawer();
      if (act === 'logs') openLogsFor(d.container);
      else handleContainerAction(act, d.container);
    });
  });

  const drawer = document.getElementById('deployDrawer');
  drawer.removeAttribute('inert');
  drawer.setAttribute('aria-hidden', 'false');
  drawer.classList.add('open');
  document.getElementById('deployDrawerBackdrop').classList.add('open');
  document.body.classList.add('drawer-open');
  drawer.querySelector('.drawer-body').scrollTop = 0;
  drawer.querySelector('.drawer-header .icon-btn').focus();
}

function closeDeployDrawer() {
  const drawer = document.getElementById('deployDrawer');
  if (!drawer || !drawer.classList.contains('open')) return;
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  drawer.setAttribute('inert', '');
  document.getElementById('deployDrawerBackdrop').classList.remove('open');
  document.body.classList.remove('drawer-open');
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeDeployDrawer();
});

// ---- Audit pagination
function auditPageWindow(current, last) {
  // 1 … 4 5 [6] 7 8 … 20
  const pages = new Set([1, last]);
  for (let p = current - 2; p <= current + 2; p++) if (p >= 1 && p <= last) pages.add(p);
  const sorted = [...pages].sort((a, b) => a - b);
  const out = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push(null);
    out.push(p);
  });
  return out;
}

function renderAuditPager(totalFiltered) {
  const info = document.getElementById('auditPagerInfo');
  const pagesEl = document.getElementById('auditPagerPages');
  if (!info || !pagesEl) return;

  const size = state.auditPageSize;
  const last = Math.max(1, Math.ceil(totalFiltered / size));
  const page = Math.min(state.auditPage, last);
  const from = totalFiltered === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(page * size, totalFiltered);
  info.innerHTML = `Hiển thị <b>${from.toLocaleString('vi-VN')}–${to.toLocaleString('vi-VN')}</b> / ${totalFiltered.toLocaleString('vi-VN')} bản ghi`;

  const arrow = (target, label, path, disabled) =>
    `<button type="button" class="pager-btn" data-page="${target}" aria-label="${label}" ${disabled ? 'disabled' : ''}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="${path}"/></svg>
    </button>`;

  pagesEl.innerHTML = [
    arrow(page - 1, 'Trang trước', '15 18 9 12 15 6', page <= 1),
    ...auditPageWindow(page, last).map(p => p === null
      ? '<span class="pager-gap" aria-hidden="true">…</span>'
      : `<button type="button" class="pager-btn ${p === page ? 'active' : ''}" data-page="${p}" ${p === page ? 'aria-current="page"' : ''}>${p}</button>`),
    arrow(page + 1, 'Trang sau', '9 18 15 12 9 6', page >= last)
  ].join('');

  pagesEl.querySelectorAll('[data-page]').forEach(btn => {
    btn.addEventListener('click', () => goToAuditPage(parseInt(btn.dataset.page, 10)));
  });
}

function goToAuditPage(page) {
  if (!Number.isFinite(page) || page < 1) return;
  state.auditPage = page;
  refreshAuditLogs();
  document.getElementById('auditTable')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setAuditPageSize(size) {
  state.auditPageSize = parseInt(size, 10) || 25;
  state.auditPage = 1;
  refreshAuditLogs();
}
