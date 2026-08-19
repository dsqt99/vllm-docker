# Triển khai vLLM tương thích với OpenAI API

Dự án này thiết lập một hệ thống LLM hiệu năng cao sử dụng **vLLM** (để chạy inference) và **LiteLLM** (làm API Gateway), hoàn toàn tương thích với định dạng OpenAI API.

## Kiến trúc hệ thống

*   **vLLM Services**:
    *   `vllm-text`: Container chuyên dụng cho các model xử lý văn bản (ví dụ: Qwen-8B).
    *   `vllm-vl`: Container chuyên dụng cho các model Vision-Language (ví dụ: Qwen-VL-8B).
*   **LiteLLM Gateway**:
    *   Tổng hợp các dịch vụ vLLM thành một đầu mối (endpoint) API duy nhất.
    *   Cung cấp giao diện chuẩn tương thích OpenAI (`/v1/chat/completions`, v.v.).
    *   Quản lý xác thực (authentication) thông qua Master Key.
*   **Traefik**:
    *   Public dịch vụ LiteLLM ra bên ngoài thông qua domain `vllm.anm05.com` với bảo mật SSL/TLS.

## Yêu cầu tiên quyết

*   Docker & Docker Compose.
*   NVIDIA Utilities (đã cài đặt driver đầy đủ).
*   **NVIDIA Container Toolkit** phải được cài đặt và cấu hình để Docker có thể truy cập GPU.

## Cài đặt & Cấu hình

### 1. Cấu hình biến môi trường (.env)
Copy file cấu hình mẫu (hoặc tạo mới) và điền các thông tin của bạn:

```bash
# Domain cho API
DOMAIN=vllm.anm05.com

# Model Setup (ID trên HuggingFace)
TEXT_MODEL_ID=Qwen/Qwen3-8B
VL_MODEL_ID=Qwen/Qwen3-VL-8B-Instruct

# HuggingFace Token (Bắt buộc với các gated models)
HF_TOKEN=hf_...

# Phân bổ GPU (kiểm tra ID bằng lệnh `nvidia-smi`)
TEXT_GPU_DEVICE=2
VL_GPU_DEVICE=1

# Bảo mật (Key này dùng để gọi API)
LITELLM_MASTER_KEY=sk-your-secure-key-here
```

### 2. Cấu hình LiteLLM (litellm_config.yaml)
File này ánh xạ tên model (mà người dùng gọi) tới backend vLLM tương ứng. Bạn thường không cần sửa file này trừ khi muốn thêm container mới hoặc đổi tên model.

```yaml
model_list:
  - model_name: qwen-text
    litellm_params:
      model: openai/Qwen/Qwen3-8B  # Khớp với định dạng OpenAI
      api_base: http://vllm-text:8000/v1
      api_key: "EMPTY"
```

## Triển khai (Deployment)

Chạy lệnh sau để khởi động toàn bộ stack:

```bash
docker-compose up -d
```

Kiểm tra logs để đảm bảo model được tải thành công (lần đầu tiên sẽ mất thời gian để tải model):

```bash
docker-compose logs -f vllm-text
# hoặc
docker-compose logs -f vllm-vl
```

## Cách sử dụng (Tương thích OpenAI API)

Vì hệ thống tương thích với OpenAI, bạn có thể sử dụng các thư viện chuẩn (như `openai-python`) hoặc lệnh `curl` đơn giản.

### Base URL & Keys
*   **Base URL**: `https://vllm.anm05.com/v1` (hoặc `http://localhost:4000/v1` nếu test local không qua Traefik)
*   **API Key**: Giá trị của `LITELLM_MASTER_KEY` trong file `.env` của bạn.

### Ví dụ: Python Client
```python
from openai import OpenAI

client = OpenAI(
    base_url="https://vllm.anm05.com/v1",
    api_key="your-litellm-master-key"
)

# Chat với model Text
response = client.chat.completions.create(
    model="qwen-text", # Sử dụng tên model đã định nghĩa trong litellm_config.yaml
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello, how are you?"}
    ]
)
print(response.choices[0].message.content)
```

### Ví dụ: CURL
```bash
curl -X POST https://vllm.anm05.com/v1/chat/completions \
  -H "Authorization: Bearer <LITELLM_MASTER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-text",
    "messages": [
      { "role": "user", "content": "Explain quantum computing in one sentence." }
    ]
  }'
```

## Khả năng tương thích OpenAI hoạt động như thế nào?
1.  **vLLM**: Image `vllm/vllm-openai` khởi chạy một API server tuân thủ nghiêm ngặt đặc tả của OpenAI. Nó cung cấp các endpoint như `/v1/models` và `/v1/chat/completions`.
2.  **LiteLLM**: Đóng vai trò là proxy trung gian. Khi bạn gửi request đến LiteLLM, nó sẽ chuyển tiếp đến container vLLM phù hợp (`http://vllm-text:8000/v1` hoặc `http://vllm-vl:8000/v1`) trong khi vẫn giữ nguyên định dạng request/response của OpenAI.

## Khắc phục sự cố (Troubleshooting)
*   **Container liên tục restart**: Kiểm tra logs (`docker-compose logs vllm-text`). Nguyên nhân thường do tràn bộ nhớ GPU (OOM) hoặc Model ID không hợp lệ.
*   **502 Bad Gateway**: vLLM chưa khởi động xong. Model cần thời gian để nạp vào VRAM. Hãy đợi đến khi thấy dòng "Uvicorn running on..." trong logs của vLLM.
