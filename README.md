# vLLM High-Performance Serving & Mission Control Stack

Hệ thống phục vụ suy luận mô hình ngôn ngữ lớn (LLM), đa phương thức (Vision), OCR, Vector Embedding, Reranking và Structured Decisions với hiệu năng cao, tích hợp **LiteLLM Gateway** (tương thích 100% chuẩn OpenAI API), **Manager Web UI** và cụm giám sát **Prometheus + Grafana**.

---

## 1. Kiến trúc hệ thống

```
                                    +-----------------------+
                                    |     Client / Traefik  |
                                    +-----------+-----------+
                                                |
                                      (Port 4000 / HTTPS)
                                                v
                                    +-----------------------+
                                    |   LiteLLM Gateway     |
                                    | (Auth, Route, Audit)  |
                                    +---+-------+-------+---+
                                        |       |       |
            +---------------------------+       |       +---------------------------+
            |                                   |                                   |
            v                                   v                                   v
+-----------------------+           +-----------------------+           +-----------------------+
|   vLLM Main Engine    |           |    vLLM Reranker      |           |     vLLM Embedding    |
|     (Qwen3.5-9B)      |           | (bge-reranker-v2-m3)  |           | (Qwen3-Embedding-0.6B)|
|   Port 8000 (TP=2)    |           |   Port 8005 (TP=1)    |           |   Port 8004 (TP=1)    |
+-----------------------+           +-----------------------+           +-----------------------+
            |                                   |                                   |
            v                                   v                                   v
+-----------------------+           +-----------------------+           +-----------------------+
|   vLLM Decision Qwen  |           |     vLLM HunyuanOCR   |           |  Prometheus & Grafana |
|    Port 8006 (TP=1)   |           |    Port 8003 (TP=1)   |           | Telemetry (3050/9095) |
+-----------------------+           +-----------------------+           +-----------------------+
                                                ^
                                                |
                                    +-----------+-----------+
                                    |    vLLM Manager UI    |
                                    |  (Web Dashboard:8050) |
                                    +-----------------------+
```

---

## 2. Danh mục dịch vụ & Mô hình phục vụ

| Dịch vụ / Model | Model ID HuggingFace | Vai trò chính | Port trực tiếp | Port qua Gateway (LiteLLM) |
| :--- | :--- | :--- | :--- | :--- |
| **qwen** | `Qwen/Qwen3.5-9B` | LLM Text & Vision (FP8, TP=2) | `8000` (nội bộ) | `4000` (`/v1/chat/completions`) |
| **hunyuan-ocr** | `tencent/HunyuanOCR` | OCR & Trích xuất ảnh đa ngôn ngữ | `8003` | `4000` (`/v1/chat/completions`) |
| **senocr-vi** | `VietAlphaLabs/SenOCR-Vi` | Chuyên dụng OCR tài liệu Tiếng Việt (0.96B) | `8007` | `4000` (`/v1/chat/completions`) |
| **qwen-embedding**| `Qwen/Qwen3-Embedding-0.6B` | Vector Embedding | `8004` | `4000` (`/v1/embeddings`) |
| **bge-reranker** | `BAAI/bge-reranker-v2-m3` | Reranker đa ngôn ngữ / Tiếng Việt | `8005` | `4000` (`/v1/rerank`) |
| **clef-decision** | `Cloudflare/clef-flash` | Structured Decisions / Classification / Routing | `8006` | `4000` (`/v1/decisions`, `/v1/systemone`) |
| **manager** | — | Web UI quản trị, telemetry GPU & model switcher | `8050` | `8050` |
| **prometheus** | — | Thu thập metrics hiệu năng vLLM/GPU | `9095` | `9095` |
| **grafana** | — | Dashboard trực quan hóa realtime | `3050` | `3050` |

---

## 3. Yêu cầu hệ thống

* **Hệ điều hành**: Linux (Ubuntu 20.04/22.04 LTS khuyến nghị).
* **Docker & Docker Compose v2**.
* **NVIDIA Driver & NVIDIA Container Toolkit** (`nvidia-ctk`).
* GPU VRAM tối thiểu khuyến nghị: 24GB+ (hỗ trợ phân bổ đa GPU qua Tensor Parallel).

---

## 4. Cài đặt & Khởi chạy

### Bước 1: Khởi tạo biến môi trường
Sao chép file mẫu và cấu hình:
```bash
cp .env.example .env
```

Chỉnh sửa `.env` phù hợp với phần cứng:
```env
# HuggingFace Token (nếu cần tải gated models)
HF_TOKEN=hf_...

# LiteLLM Master Key dùng để bảo vệ API Gateway
LITELLM_MASTER_KEY=sk-your-secure-master-key-here

# Phân bổ GPU cho cụm vLLM chính (TP=2)
GPU_DEVICES=0,1
```

### Bước 2: Khởi động hệ sinh thái
```bash
docker compose up -d
```

Kiểm tra trạng thái các container:
```bash
docker compose ps
```

---

## 5. Truy cập & Sử dụng

### 1. API Gateway (OpenAI Compatible)
* **Base URL**: `http://localhost:4000/v1` (hoặc thông qua reverse proxy `https://<DOMAIN>/v1`)
* **Headers**: `Authorization: Bearer <LITELLM_MASTER_KEY>`

Ví dụ gọi Chat Completion bằng `curl`:
```bash
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer <LITELLM_MASTER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-3.5-9b",
    "messages": [{"role": "user", "content": "Xin chào, hãy giới thiệu bản thân!"}],
    "max_tokens": 100
  }'
```

Chi tiết các API khác (Embedding, Reranker, Structured Decisions, Tool Calling) xem tại tài liệu [API.md](API.md).

### 2. Giao diện Web Manager & Monitoring
* **vLLM Mission Control Dashboard**: `http://<IP_SERVER>:8050`
* **Grafana Dashboard**: `http://<IP_SERVER>:3050` (Tài khoản mặc định: `admin` / `admin`)
* **Prometheus Targets**: `http://<IP_SERVER>:9095`

---

## 6. Đóng gói & Chuyển giao hệ thống (Air-Gapped Deployment)

Dự án cung cấp 2 phương thức đóng gói:

### Cách 1: Đóng gói bản phát hành chuẩn CAHY (Khuyến nghị)
Sử dụng script `export_release_images.py` tại thư mục gốc `final_ban_giao`:
```bash
# Build vLLM Manager UI (khi có thay đổi)
docker build --platform linux/amd64 -t vllm-manager:latest manager/

# Xuất riêng gói release vLLM Manager UI (~80 MB)
python ../export_release_images.py --only vllm-manager

# Hoặc xuất cả cụm AI Serving (>10 GB) và Manager UI:
python ../export_release_images.py --only vllm vllm-manager
```
Kết quả sinh ra tại `release-images-YYYYMMDD/` gồm:
- `cahy-vllm-manager-release-v1.0.0-YYYYMMDD.tar.gz` (~80 MB)
- `cahy-vllm-release-v1.0.0-YYYYMMDD.tar.gz` (>10 GB)

### Cách 2: Đóng gói trọn gói standalone bằng script shell
Dự án cung cấp script `export_bundle.sh` giúp đóng gói toàn bộ Docker Images, cấu hình và source code thành 1 file duy nhất để mang sang server offline:

```bash
chmod +x export_bundle.sh
./export_bundle.sh
```

Kết quả sẽ sinh ra file `vllm_deploy_bundle_YYYYMMDD.tar.gz`. Trên máy chủ đích, chỉ cần giải nén và chạy `./install.sh`.
