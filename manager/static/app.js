// vLLM Mission Control SPA Logic
// 100% Offline / Vanilla JS / Zero Em-Dashes
// Conforms to design-taste-frontend guidelines

const API = {
  gpuStatus: '/api/gpu/status',
  instanceStatus: '/api/instance/status',
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
  auditLogs: '/api/audit/logs',
  auditClear: '/api/audit/clear'
};

const state = {
  gpus: [],
  models: [],
  instance: null,
  currentModel: '',
  isChatStreaming: false,
  chatHistory: [],
  auditLogs: [],
  auditStatus: 'all',
  auditModel: 'all',
  auditSearch: '',
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
  const rows = document.querySelectorAll('#modelsTableBody tr');
  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    row.style.display = text.includes(query) ? '' : 'none';
  });
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

  const activeGpuDevices = (state.instance?.config?.gpu_devices || '').toLowerCase();

  gpus.forEach((gpu) => {
    const gpuUuidLower = (gpu.uuid || '').toLowerCase();
    const isVllmAssigned = activeGpuDevices.includes(gpuUuidLower);
    const hasVllmProc = gpu.processes && gpu.processes.some(p => 
      p.name.toLowerCase().includes('vllm')
    );
    const isWorker = isVllmAssigned || hasVllmProc;
    const isOtherBusy = gpu.memory_used_mb > 1500 && !isWorker;

    const card = document.createElement('div');
    card.className = `gpu-card ${isWorker ? 'active-worker' : ''}`;

    let barColor = 'fill-cyan';
    if (gpu.memory_percent > 85) barColor = 'fill-rose';
    else if (gpu.memory_percent > 65) barColor = 'fill-amber';
    else if (gpu.memory_percent > 25) barColor = 'fill-cyan';
    else barColor = 'fill-emerald';

    let badgeClass = 'badge-emerald';
    let badgeText = 'Idle Standby';
    if (isWorker) {
      badgeClass = 'badge-cyan';
      badgeText = 'vLLM Active';
    } else if (isOtherBusy) {
      badgeClass = 'badge-amber';
      badgeText = gpu.uuid === 'GPU-52ffc732-f2b1-3313-e814-31f49a8dadc3' ? 'Embedding & Reranker' : 'Busy (Other)';
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

    const statusBadge = document.getElementById('engineStatusBadge');
    const modelBadge = document.getElementById('currentModelBadge');
    const bentoModelName = document.getElementById('bentoModelName');
    const bentoModelSub = document.getElementById('bentoModelSub');
    const metricTpBadge = document.getElementById('metricTpBadge');
    const bentoCtxBadge = document.getElementById('bentoCtxBadge');
    const bentoCtxVal = document.getElementById('bentoCtxVal');

    if (data.qwen?.running) {
      if (data.qwen?.health === 'healthy') {
        statusBadge.className = 'badge badge-emerald';
        statusBadge.innerHTML = '<span class="dot-pulse"></span> Online';
      } else {
        statusBadge.className = 'badge badge-amber';
        statusBadge.innerHTML = '<span class="dot-pulse"></span> Loading Weights...';
      }
    } else {
      statusBadge.className = 'badge badge-rose';
      statusBadge.innerHTML = '<span class="dot-pulse"></span> Stopped';
    }

    if (modelBadge) {
      modelBadge.textContent = state.currentModel;
    }

    if (bentoModelName) {
      const parts = state.currentModel.split('/');
      bentoModelName.textContent = parts[parts.length - 1];
    }

    if (bentoModelSub) {
      bentoModelSub.textContent = `PagedAttention / TP = ${data.config?.tensor_parallel_size || 2}`;
    }

    if (metricTpBadge && data.config?.tensor_parallel_size) {
      metricTpBadge.textContent = `TP = ${data.config.tensor_parallel_size}`;
    }

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
    renderModelsTable(state.models, data.current_active_model);
  } catch (err) {
    console.error('Lỗi nạp danh mục model:', err);
  }
}

function renderModelsTable(models, activeModel) {
  const countBadge = document.getElementById('tabCountModels');
  if (countBadge) countBadge.textContent = models.length;

  const tbody = document.getElementById('modelsTableBody');
  if (!tbody) return;
  tbody.replaceChildren();

  if (models.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="5" style="text-align: center; color: var(--text-dim); padding: 2rem;">Không tìm thấy model nào trong cache local.</td>';
    tbody.appendChild(tr);
    return;
  }

  models.forEach((m) => {
    const tr = document.createElement('tr');
    const isActive = (m.model_id === activeModel);

    const tagsHtml = m.tags.map(t => {
      let colorClass = 'badge-cyan';
      if (t === 'Vision-Language') colorClass = 'badge-amber';
      else if (t === 'FP8' || t === 'AWQ') colorClass = 'badge-green';
      return `<span class="badge ${colorClass}" style="font-size: 0.7rem; padding: 0.12rem 0.45rem;">${escapeHtml(t)}</span>`;
    }).join(' ');

    const safeModelId = escapeHtml(m.model_id);
    const safeRepoName = escapeHtml(m.repo_name);
    const safeParam = escapeHtml(m.param_size);

    tr.innerHTML = `
      <td>
        <div style="font-weight: 600; color: #fff;">${safeRepoName}</div>
        <div style="font-size: 0.72rem; color: var(--text-dim); font-family: var(--font-mono);">${safeModelId}</div>
      </td>
      <td><span style="font-weight: 600; color: var(--accent);">${safeParam}</span></td>
      <td>${m.size_gb} GB</td>
      <td>${tagsHtml}</td>
      <td style="text-align: right; white-space: nowrap;">
        ${isActive 
          ? '<span class="badge badge-green">Đang Kích Hoạt</span>' 
          : `
            <button class="btn btn-primary btn-sm btn-switch" data-model="${safeModelId}">Kích Hoạt</button>
            <button class="btn btn-danger btn-sm btn-delete-model" data-model="${safeModelId}" data-name="${safeRepoName}" data-size="${m.size_gb}" title="Xóa mô hình khỏi ổ cứng">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
              Xóa
            </button>
          `
        }
      </td>
    `;
    const switchBtn = tr.querySelector('.btn-switch');
    if (switchBtn) {
      switchBtn.addEventListener('click', () => openSwitchModal(m.model_id));
    }
    const delBtn = tr.querySelector('.btn-delete-model');
    if (delBtn) {
      delBtn.addEventListener('click', () => deleteModel(m.model_id, m.repo_name, m.size_gb));
    }
    tbody.appendChild(tr);
  });
}

// Model Deletion
async function deleteModel(modelId, repoName, sizeGb) {
  if (!confirm(`Xác nhận xóa vĩnh viễn mô hình '${repoName}' (${sizeGb} GB) khỏi ổ cứng máy chủ để giải phóng dung lượng?`)) return;

  try {
    showToast(`Đang xóa mô hình ${repoName}...`, 'info');
    const res = await fetch(API.modelDelete, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: modelId })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message, 'success');
      refreshLocalModels();
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
    const res = await fetch(`${API.instanceLogs}?tail=80`);
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
      setTimeout(refreshInstanceStatus, 1600);
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

  try {
    const response = await fetch(API.testChat, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: state.chatHistory,
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
    refreshAuditLogs();
  }, 350);
}

function setAuditStatusFilter(status) {
  state.auditStatus = status;
  document.querySelectorAll('.filter-chip').forEach(chip => {
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
    limit: '150',
    status: state.auditStatus || 'all'
  });
  if (selectedModel && selectedModel !== 'all') params.append('model', selectedModel);
  if (state.auditSearch) params.append('search', state.auditSearch);

  try {
    const res = await fetch(`${API.auditLogs}?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.auditLogs = data.logs || [];

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
  refreshLocalModels();
  refreshLoraAdapters();
  refreshLogs();
  refreshAuditLogs();

  // 3.5s Polling for real-time telemetry
  setInterval(() => {
    refreshGpuStatus();
    refreshInstanceStatus();
  }, 3500);

  // Bind Form Switcher
  const switchForm = document.getElementById('switchForm');
  if (switchForm) {
    switchForm.addEventListener('submit', submitModelSwitch);
  }
});
