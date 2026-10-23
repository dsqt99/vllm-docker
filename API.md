# Hướng dẫn sử dụng API (OpenAI Compatible)

Tài liệu này hướng dẫn chi tiết cách sử dụng các API được cung cấp bởi hệ thống vLLM & LiteLLM.

## 1. Thông tin kết nối cơ bản

*   **Base URL**: `https://vllm.anm05.com/v1`
*   **Authentication**: Sử dụng **Bearer Token** với giá trị là `LITELLM_MASTER_KEY` định nghĩa trong file `.env`.
    - Header: `Authorization: Bearer your-litellm-master-key`

## 2. Danh sách Model khả dụng

| Tên Model | Loại | Model gốc | Port trực tiếp |
| :--- | :--- | :--- | :--- |
| `qwen-3.5-9b` / `Qwen/Qwen3.5-9B` | Văn bản (LLM) | Qwen3.5-9B | `8000` (nội bộ) |
| `hunyuan-ocr` / `tencent/HunyuanOCR` | OCR & Trích xuất ảnh | Tencent HunyuanOCR | `8003` |
| `qwen3-embedding-0.6b` / `Qwen/Qwen3-Embedding-0.6B` | Vector Embedding | Qwen3-Embedding-0.6B | `8004` |
| `bge-reranker-v2-m3` / `BAAI/bge-reranker-v2-m3` | Reranker (Đa ngôn ngữ / Tiếng Việt) | BAAI/bge-reranker-v2-m3 | `8005` |
| `decision-qwen` / `qwen-decision` | Structured Decisions / Classification / Routing | Qwen3.5-9B (`--logprobs-mode raw_logprobs`) | `8006` / `8000` |

Bạn cũng có thể lấy danh sách model trực tiếp qua API:
```bash
curl https://vllm.anm05.com/v1/models \
  -H "Authorization: Bearer <LITELLM_MASTER_KEY>"
```

---

## 3. Chat Completions (Văn bản)

Sử dụng cho các yêu cầu hỏi đáp văn bản thông thường với model `qwen-text`.

### Ví dụ CURL
```bash
curl -X POST https://vllm.anm05.com/v1/chat/completions \
  -H "Authorization: Bearer <LITELLM_MASTER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-text",
    "messages": [
      {"role": "system", "content": "Bạn là một trợ lý ảo tiếng Việt."},
      {"role": "user", "content": "Xin chào, bạn có thể giúp gì cho tôi?"}
    ],
    "temperature": 0.7
  }'
```

---

## 4. Multi-input (Vision/Hình ảnh)

Sử dụng model `qwen-vl` để phân tích hình ảnh. Định dạng input tuân theo chuẩn OpenAI Vision.

### Ví dụ CURL (Gửi URL hình ảnh hoặc Base64)
```bash
curl -X POST https://vllm.anm05.com/v1/chat/completions \
  -H "Authorization: Bearer <LITELLM_MASTER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-vl",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "Mô tả hình ảnh này giúp tôi." },
          {
            "type": "image_url",
            "image_url": {
              "url": "https://example.com/image.jpg"
            }
          }
        ]
      }
    ],
    "max_tokens": 300
  }'
```

---

## 5. Streaming API

Để nhận kết quả dạng streaming (trả về từng từ một), đặt tham số `"stream": true`.

### Ví dụ CURL
```bash
curl -X POST https://vllm.anm05.com/v1/chat/completions \
  -H "Authorization: Bearer <LITELLM_MASTER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-text",
    "messages": [
      { "role": "user", "content": "Viết một bài thơ ngắn về biển." }
    ],
    "stream": true
  }'
```
*Kết quả sẽ trả về định dạng `server-sent events` (SSE).*

---

## 6. Reranking API (Tái sắp xếp tài liệu theo độ liên quan)

Sử dụng model `BAAI/bge-reranker-v2-m3` tối ưu cho tìm kiếm, RAG và hỗ trợ rất tốt tiếng Việt.

*   **Endpoint qua LiteLLM Gateway**: `POST https://vllm.anm05.com/v1/rerank` hoặc `POST http://localhost:4000/v1/rerank`
*   **Endpoint trực tiếp vLLM**: `POST http://localhost:8005/v1/rerank` (hoặc `/v1/score`)

### Ví dụ CURL
```bash
curl -X POST https://vllm.anm05.com/v1/rerank \
  -H "Authorization: Bearer <LITELLM_MASTER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "BAAI/bge-reranker-v2-m3",
    "query": "Thủ đô của Việt Nam là gì?",
    "documents": [
      "Hà Nội là thủ đô của Việt Nam với bề dày lịch sử ngàn năm văn hiến.",
      "TP Hồ Chí Minh là đầu tàu kinh tế lớn nhất cả nước.",
      "Đà Nẵng là thành phố đáng sống bên bờ sông Hàn."
    ],
    "top_n": 3
  }'
```

### Kết quả mẫu trả về
```json
{
  "id": "rerank-xxx",
  "results": [
    {
      "index": 0,
      "relevance_score": 0.9852,
      "document": { "text": "Hà Nội là thủ đô của Việt Nam với bề dày lịch sử ngàn năm văn hiến." }
    },
    {
      "index": 1,
      "relevance_score": 0.0812,
      "document": { "text": "TP Hồ Chí Minh là đầu tàu kinh tế lớn nhất cả nước." }
    },
    {
      "index": 2,
      "relevance_score": 0.0345,
      "document": { "text": "Đà Nẵng là thành phố đáng sống bên bờ sông Hàn." }
    }
  ]
}
```

---

## 7. Structured Decisions API (/v1/systemone & /v1/decisions)

Mô hình Structured Decision ánh xạ trạng thái đầu vào (state/ticket/document) trực tiếp tới các phương án phân loại (options), trả về xác suất (probabilities) và độ tin cậy (confidence) trong 1 forward pass mà không sinh text tự do.

Hỗ trợ 2 chuẩn endpoint:
*   **vLLM Native (`POST /v1/systemone`)**: Nhận `state` và danh sách `questions` với các loại `choice`, `noul` (yes/no), `score`.
*   **OpenAI Decisions Spec (`POST /v1/decisions`)**: Chuẩn OpenAI tương thích qua Python SDK `client.decisions.create(...)`.

### Ví dụ CURL - /v1/systemone
```bash
curl -X POST https://vllm.anm05.com/v1/systemone \
  -H "Authorization: Bearer <LITELLM_MASTER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen3.5-9B",
    "state": {"ticket": "Thẻ của tôi bị trừ 2 lần cho cùng 1 đơn hàng."},
    "questions": {
      "department": {
        "type": "choice",
        "instructions": "Bộ phận nào cần xử lý khiếu nại này?",
        "criteria": {
          "billing": "Thanh toán, hoàn tiền",
          "shipping": "Vận chuyển",
          "security": "Bảo mật tài khoản"
        }
      },
      "urgent": {
        "type": "noul",
        "instructions": "Có cần xử lý gấp trong 1 giờ không?",
        "criteria": {"true": "Tài khoản bị khóa hoặc có phát sinh dòng tiền sai"}
      },
      "tone": {
        "type": "score",
        "instructions": "Khách hàng tức giận ở mức nào?",
        "criteria": ["bình tĩnh", "khó chịu", "cực kỳ bức xúc"]
      }
    },
    "chat_template_kwargs": {"enable_thinking": false}
  }'
```

### Ví dụ CURL - /v1/decisions (OpenAI Format)
```bash
curl -X POST https://vllm.anm05.com/v1/decisions \
  -H "Authorization: Bearer <LITELLM_MASTER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen3.5-9B",
    "input": "Hàng gửi đến bị vỡ nát màn hình.",
    "questions": [
      {
        "type": "predicate",
        "name": "damaged",
        "instructions": "Sản phẩm có bị vỡ hỏng không?"
      },
      {
        "type": "choice",
        "name": "department",
        "instructions": "Phòng ban nào xử lý?",
        "choices": [{"value": "returns"}, {"value": "billing"}]
      }
    ]
  }'
```

---

## 8. Ví dụ sử dụng với Thư viện Python

Đây là cách khuyên dùng nếu bạn phát triển ứng dụng bằng Python.

```python
from openai import OpenAI

# Khởi tạo client
client = OpenAI(
    base_url="https://vllm.anm05.com/v1",
    api_key="your-litellm-master-key"
)

# 1. Chat thông thường (Text)
def chat_simple():
    chat_completion = client.chat.completions.create(
        messages=[{"role": "user", "content": "Chào bạn!"}],
        model="qwen-text",
    )
    print("Response:", chat_completion.choices[0].message.content)

# 2. Streaming response
def chat_stream():
    stream = client.chat.completions.create(
        model="qwen-text",
        messages=[{"role": "user", "content": "Kể một câu chuyện cười."}],
        stream=True,
    )
    for chunk in stream:
        if chunk.choices[0].delta.content is not None:
            print(chunk.choices[0].delta.content, end="", flush=True)

# 3. Vision (Multi-input)
def chat_vision():
    response = client.chat.completions.create(
        model="qwen-vl",
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Trong ảnh có gì?"},
                    {
                        "type": "image_url",
                        "image_url": {"url": "https://example.com/image.png"},
                    },
                ],
            }
        ],
        max_tokens=300,
    )
# 4. Rerank tài liệu (Tiếng Việt)
def rerank_documents():
    import requests
    response = requests.post(
        "https://vllm.anm05.com/v1/rerank",
        headers={
            "Authorization": "Bearer your-litellm-master-key",
            "Content-Type": "application/json"
        },
        json={
            "model": "BAAI/bge-reranker-v2-m3",
            "query": "Hà Nội có những trường đại học nào?",
            "documents": [
                "Đại học Quốc gia Hà Nội là một trong những trung tâm đào tạo hàng đầu.",
                "Đại học Bách Khoa Hà Nội có truyền thống đào tạo kỹ thuật.",
                "Bún chả là món ăn ngon nổi tiếng của Hà Nội."
            ],
            "top_n": 2
        }
    )
    print(response.json())

if __name__ == "__main__":
    chat_simple()
    print("\n--- Streaming ---")
    chat_stream()
    print("\n--- Rerank ---")
    rerank_documents()
```

---

## Lưu ý quan trọng
- **Model VL**: Khi sử dụng vision, hãy đảm bảo dùng đúng tên model `qwen-vl`.
- **Hiệu năng**: Các request vision thường tốn nhiều VRAM và thời gian xử lý hơn.
- **Port**: Local endpoint mặc định là `4000` (LiteLLM), không phải `8000` (vLLM trực tiếp).
