# Hướng dẫn sử dụng API (OpenAI Compatible)

Tài liệu này hướng dẫn chi tiết cách sử dụng các API được cung cấp bởi hệ thống vLLM & LiteLLM.

## 1. Thông tin kết nối cơ bản

*   **Base URL**: `https://vllm.anm05.com/v1`
*   **Authentication**: Sử dụng **Bearer Token** với giá trị là `LITELLM_MASTER_KEY` định nghĩa trong file `.env`.
    - Header: `Authorization: Bearer your-litellm-master-key`

## 2. Danh sách Model khả dụng

| Tên Model | Loại | Model gốc |
| :--- | :--- | :--- |
| `qwen-text` | Văn bản (Text) | Qwen3-8B |
| `qwen-vl` | Đa phương thức (Vision) | Qwen3-VL-8B-Instruct |

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

## 6. Ví dụ sử dụng với Thư viện Python (openai)

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
    print(response.choices[0].message.content)

if __name__ == "__main__":
    chat_simple()
    print("\n--- Streaming ---")
    chat_stream()
```

---

## Lưu ý quan trọng
- **Model VL**: Khi sử dụng vision, hãy đảm bảo dùng đúng tên model `qwen-vl`.
- **Hiệu năng**: Các request vision thường tốn nhiều VRAM và thời gian xử lý hơn.
- **Port**: Local endpoint mặc định là `4000` (LiteLLM), không phải `8000` (vLLM trực tiếp).
