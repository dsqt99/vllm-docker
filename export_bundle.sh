#!/usr/bin/env bash
# ==============================================================================
# vLLM Cluster & Grafana Monitoring Export Script
# Đóng gói toàn bộ Images, Cấu hình, Dashboards để chuyển giao sang server khác
# ==============================================================================

set -e

EXPORT_DIR="./vllm_deploy_bundle_$(date +%Y%m%d)"
mkdir -p "$EXPORT_DIR/images"
mkdir -p "$EXPORT_DIR/config"

echo "=================================================================="
echo " [1/4] Chuẩn bị đóng gói vLLM Manager & Monitoring Stack..."
echo "=================================================================="

# 1. Build vllm-manager & vllm-ocr image nếu chưa có tag
echo "--> Building vllm-manager image..."
docker compose build manager

echo "--> Building vllm-ocr image..."
docker build -t vllm-ocr:latest -f Dockerfile.ocr . || true

# 2. Xuất danh sách Docker Images ra file nén tar.gz
echo "--> [2/4] Đóng gói các Docker Images (vLLM, vLLM-OCR, LiteLLM, Manager, Prometheus, Grafana)..."
echo "    Quá trình này có thể mất vài phút tùy tốc độ ổ đĩa..."

IMAGES=(
  "vllm/vllm-openai:nightly"
  "vllm-ocr:latest"
  "ghcr.io/berriai/litellm:main-latest"
  "prom/prometheus:v2.51.0"
  "grafana/grafana:10.4.0"
)

# Kéo trước Prometheus và Grafana nếu chưa có local
docker pull prom/prometheus:v2.51.0 || true
docker pull grafana/grafana:10.4.0 || true

# Lưu images
docker save \
  vllm/vllm-openai:nightly \
  $(docker images -q vllm-ocr:latest 2>/dev/null && echo "vllm-ocr:latest") \
  ghcr.io/berriai/litellm:main-latest \
  prom/prometheus:v2.51.0 \
  grafana/grafana:10.4.0 \
  | gzip > "$EXPORT_DIR/images/vllm_stack_images.tar.gz"

echo "--> Đóng gói vllm-manager..."
docker save vllm-docker-manager:latest | gzip > "$EXPORT_DIR/images/vllm_manager_image.tar.gz" || \
docker save $(docker images --format "{{.Repository}}:{{.Tag}}" | grep manager | head -n 1) | gzip > "$EXPORT_DIR/images/vllm_manager_image.tar.gz"

# 3. Sao chép toàn bộ cấu hình, dashboard và source manager
echo "--> [3/4] Sao chép cấu hình, dashboard và mã nguồn manager..."
cp docker-compose.yml "$EXPORT_DIR/config/"
cp docker-compose.prod.yml "$EXPORT_DIR/config/" || true
cp Dockerfile.ocr "$EXPORT_DIR/config/" || true
cp patch_xdrope.py "$EXPORT_DIR/config/" || true
cp litellm_config.yaml "$EXPORT_DIR/config/"
cp litellm_logger.py "$EXPORT_DIR/config/"
cp patch_strategies.py "$EXPORT_DIR/config/" || true
cp .env.example "$EXPORT_DIR/config/.env.example"
cp -r monitoring "$EXPORT_DIR/config/"
cp -r manager "$EXPORT_DIR/config/"

# 4. Tạo script cài đặt tự động tại máy đích
cat << 'EOF' > "$EXPORT_DIR/install.sh"
#!/usr/bin/env bash
set -e

echo "=================================================================="
echo " TRIỂN KHAI CỤM vLLM MISSION CONTROL & GRAFANA MONITORING TỰ ĐỘNG"
echo "=================================================================="

# 1. Kiểm tra driver NVIDIA
if ! command -v nvidia-smi &> /dev/null; then
    echo "❌ LỖI: Máy chủ đích chưa cài đặt NVIDIA Driver hoặc NVIDIA Container Toolkit!"
    echo "Vui lòng cài đặt nvidia-container-toolkit trước khi tiếp tục."
    exit 1
fi

echo "✅ Đã tìm thấy NVIDIA Driver:"
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader

# 2. Nạp Docker Images từ file nén
echo "--> Nạp các Docker Images vào hệ thống..."
for img in images/*.tar.gz; do
    if [ -f "$img" ]; then
        echo "    Loading $img..."
        docker load < "$img"
    fi
done

# 3. Thiết lập file .env nếu chưa có
if [ ! -f "config/.env" ]; then
    echo "--> Tạo file .env từ .env.example..."
    cp config/.env.example config/.env
    # Tự động gán HF_CACHE_DIR theo thư mục cache của user hiện tại trên máy chủ
    TARGET_CACHE="$HOME/.cache/huggingface"
    sed -i "s|HF_CACHE_DIR=.*|HF_CACHE_DIR=$TARGET_CACHE|g" config/.env
    echo "--> Đã cấu hình HF_CACHE_DIR=$TARGET_CACHE trong config/.env"
fi

# 4. Khởi chạy toàn bộ hệ sinh thái
echo "--> Khởi động toàn bộ container (vLLM, LiteLLM, Manager, Prometheus, Grafana)..."
cd config
docker compose up -d

echo "=================================================================="
echo "🎉 TRIỂN KHAI HOÀN TẤT!"
echo " - vLLM Manager Web UI:  http://<IP_SERVER>:8050"
echo " - Grafana Dashboard:   http://<IP_SERVER>:3000 (admin / admin)"
echo " - LiteLLM OpenAI API:  http://<IP_SERVER>:4000/v1"
echo " - Prometheus Telemetry: http://<IP_SERVER>:9090"
echo "=================================================================="
EOF

chmod +x "$EXPORT_DIR/install.sh"

echo "=================================================================="
echo " [4/4] Nén toàn bộ gói phân phối thành file triển khai duy nhất..."
tar -czf "${EXPORT_DIR}.tar.gz" "$EXPORT_DIR"
echo "=================================================================="
echo " THÀNH CÔNG!"
echo " File triển khai hoàn chỉnh: ${EXPORT_DIR}.tar.gz"
echo " Bạn chỉ cần copy file này sang máy chủ đích, giải nén và chạy ./install.sh"
echo "=================================================================="
