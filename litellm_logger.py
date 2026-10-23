import os
import json
import time
import uuid
import traceback
from datetime import datetime
from typing import Optional, Dict, Any

from litellm.integrations.custom_logger import CustomLogger

LOG_FILE_PATH = os.environ.get("AUDIT_LOG_FILE", "/app/logs/audit.log")
MAX_LOG_ENTRIES = 10000

# Cache recently logged request IDs to avoid duplicate entries
_recently_logged: Dict[str, float] = {}

def clean_recent_cache():
    now = time.time()
    for k in list(_recently_logged.keys()):
        if now - _recently_logged[k] > 60:
            _recently_logged.pop(k, None)

def parse_error_cause(exception_obj, exception_str: str) -> dict:
    """
    Phân tích thông báo lỗi thành mã phân loại, nguyên nhân gốc rễ và giải pháp khắc phục.
    """
    err_lower = (exception_str or "").lower()
    
    category = "SERVER_ERROR"
    cause = "Lỗi máy chủ nội bộ trong quá trình xử lý yêu cầu."
    suggested_action = "Kiểm tra log của vLLM engine để biết chi tiết stack trace."
    status_code = 500

    # 1. GPU OOM
    if any(k in err_lower for k in ["out of memory", "cuda out of memory", "oom", "cuda error: out of memory", "cudaruntimeerror"]):
        category = "GPU_OOM"
        cause = "Tràn bộ nhớ GPU (CUDA Out of Memory). Quá trình cấp phát KV Cache hoặc xử lý prompt dài vượt quá VRAM còn lại."
        suggested_action = "Hạ thấp max-model-len, giảm gpu-memory-utilization (ví dụ 0.88), hoặc kích hoạt --kv-cache-dtype fp8."
        status_code = 500

    # 2. Backend Connection Refused (vLLM chết hoặc chưa xong)
    elif any(k in err_lower for k in ["connection refused", "connecterror", "connect_error", "all connection attempts failed", "failed to establish a new connection"]):
        category = "BACKEND_UNAVAILABLE"
        cause = "Không thể kết nối đến vLLM backend container (Connection Refused). Container vLLM có thể đang tải trọng số mô hình hoặc đã bị crash."
        suggested_action = "Kiểm tra trạng thái container qwen/ocr bằng 'docker ps' và xem log vLLM để xác nhận engine đã sẵn sàng (Uvicorn running on http://0.0.0.0:8000)."
        status_code = 502

    # 3. Model Not Found
    elif any(k in err_lower for k in ["invalid model name", "model not found", "does not exist", "model_not_found"]):
        category = "MODEL_NOT_FOUND"
        cause = "Tên mô hình (model) không tồn tại hoặc chưa được khai báo trong litellm_config.yaml."
        suggested_action = "Gọi GET /v1/models để xem danh sách mô hình được hỗ trợ, hoặc cập nhật litellm_config.yaml và tải lại LiteLLM."
        status_code = 404

    # 4. Context Window Exceeded
    elif any(k in err_lower for k in ["maximum context length", "context window", "prompt is too long", "exceeds maximum"]):
        category = "CONTEXT_WINDOW_EXCEEDED"
        cause = "Tổng số token của prompt và max_tokens vượt quá giới hạn ngữ cảnh (Context Window) đã thiết lập cho mô hình."
        suggested_action = "Cắt giảm độ dài đoạn hội thoại đầu vào hoặc tăng tham số --max-model-len khi chạy vLLM."
        status_code = 400

    # 5. Authentication Failure
    elif any(k in err_lower for k in ["unauthorized", "invalid api key", "missing api key", "authentication error", "invalid_api_key"]):
        category = "AUTH_ERROR"
        cause = "API Key không hợp lệ hoặc thiếu header Authorization."
        suggested_action = "Kiểm tra header Authorization: Bearer <LITELLM_MASTER_KEY> trong client."
        status_code = 401

    # 6. Rate Limit
    elif any(k in err_lower for k in ["rate limit", "too many requests", "rate_limit_exceeded"]):
        category = "RATE_LIMIT"
        cause = "Yêu cầu bị từ chối do vượt quá hạn mức tốc độ (RPM / TPM)."
        suggested_action = "Giảm tần suất gửi yêu cầu hoặc cấu hình lại giới hạn rate limit trong LiteLLM."
        status_code = 429

    # 7. Request Timeout
    elif any(k in err_lower for k in ["timed out", "timeout", "readtimeouterror"]):
        category = "TIMEOUT"
        cause = "Hết thời gian chờ phản hồi từ backend vLLM. Quá trình xử lý prompt quá lâu hoặc hàng đợi GPU bị tắc nghẽn."
        suggested_action = "Kiểm tra độ bận của GPU, giảm số token cần sinh hoặc tăng timeout trong client."
        status_code = 504

    # 8. Bad Request / Validation
    elif any(k in err_lower for k in ["bad request", "validation error", "schema error", "invalid request"]):
        category = "BAD_REQUEST"
        cause = "Payload yêu cầu không đúng định dạng chuẩn OpenAI API (thiếu messages, trường bị sai kiểu dữ liệu)."
        suggested_action = "Kiểm tra cấu trúc JSON gửi lên xem có đầy đủ trường 'model' và mảng 'messages' hay không."
        status_code = 400

    if hasattr(exception_obj, "status_code") and getattr(exception_obj, "status_code"):
        status_code = getattr(exception_obj, "status_code")

    return {
        "category": category,
        "cause": cause,
        "suggested_action": suggested_action,
        "status_code": status_code
    }


def write_log_entry(entry: dict):
    try:
        clean_recent_cache()
        # Fingerprint based on model + messages + status to avoid double logging from multiple hooks
        model = entry.get("model", "")
        status = entry.get("status", "")
        msgs_str = str(entry.get("messages", ""))[:120]
        fingerprint = f"{model}:{status}:{msgs_str}"

        now = time.time()
        if fingerprint in _recently_logged and (now - _recently_logged[fingerprint]) < 2.5:
            return
        _recently_logged[fingerprint] = now

        req_id = entry.get("id")
        if req_id:
            _recently_logged[req_id] = now

        os.makedirs(os.path.dirname(LOG_FILE_PATH), exist_ok=True)
        line = json.dumps(entry, ensure_ascii=False) + "\n"
        with open(LOG_FILE_PATH, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception as e:
        print(f"[AuditLogger Error] Không thể ghi file audit log: {e}")


class AuditLogger(CustomLogger):
    def __init__(self):
        super().__init__()
        os.makedirs(os.path.dirname(LOG_FILE_PATH), exist_ok=True)

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        try:
            latency_ms = round((end_time - start_time).total_seconds() * 1000, 1) if (start_time and end_time) else 0
            standard_logging_object = kwargs.get("standard_logging_object", {})
            model = kwargs.get("model") or standard_logging_object.get("model", "unknown")
            messages = kwargs.get("messages") or kwargs.get("input")
            call_id = kwargs.get("litellm_call_id") or str(uuid.uuid4())[:8]

            response_text = None
            usage = {}
            if hasattr(response_obj, "get"):
                choices = response_obj.get("choices", [])
                if choices and isinstance(choices, list):
                    msg = choices[0].get("message", {})
                    response_text = msg.get("content")
                usage = response_obj.get("usage", {})
            elif hasattr(response_obj, "choices"):
                choices = getattr(response_obj, "choices", [])
                if choices:
                    response_text = getattr(getattr(choices[0], "message", None), "content", None)
                res_usage = getattr(response_obj, "usage", None)
                if res_usage:
                    usage = {
                        "prompt_tokens": getattr(res_usage, "prompt_tokens", 0),
                        "completion_tokens": getattr(res_usage, "completion_tokens", 0),
                        "total_tokens": getattr(res_usage, "total_tokens", 0)
                    }

            entry = {
                "id": call_id,
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "status": "success",
                "status_code": 200,
                "model": model,
                "latency_ms": latency_ms,
                "usage": {
                    "prompt_tokens": usage.get("prompt_tokens", 0),
                    "completion_tokens": usage.get("completion_tokens", 0),
                    "total_tokens": usage.get("total_tokens", 0)
                },
                "messages": messages,
                "response": response_text[:1200] if response_text else None,
                "error": None
            }
            write_log_entry(entry)
        except Exception as e:
            print(f"[AuditLogger Error] Trong async_log_success_event: {e}")

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        try:
            latency_ms = round((end_time - start_time).total_seconds() * 1000, 1) if (start_time and end_time) else 0
            model = kwargs.get("model", "unknown")
            messages = kwargs.get("messages") or kwargs.get("input")
            call_id = kwargs.get("litellm_call_id") or str(uuid.uuid4())[:8]

            exception_obj = kwargs.get("exception")
            err_str = str(exception_obj)
            err_analysis = parse_error_cause(exception_obj, err_str)

            entry = {
                "id": call_id,
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "status": "error",
                "status_code": err_analysis["status_code"],
                "model": model,
                "latency_ms": latency_ms,
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                "messages": messages,
                "response": None,
                "error": {
                    "category": err_analysis["category"],
                    "type": type(exception_obj).__name__ if exception_obj else "UnknownException",
                    "message": err_str,
                    "cause": err_analysis["cause"],
                    "suggested_action": err_analysis["suggested_action"]
                }
            }
            write_log_entry(entry)
        except Exception as e:
            print(f"[AuditLogger Error] Trong async_log_failure_event: {e}")

    async def async_post_call_failure_hook(self, request_data, original_exception, user_api_key_dict, traceback_str=None):
        try:
            call_id = str(uuid.uuid4())[:8]
            model = request_data.get("model", "unknown") if isinstance(request_data, dict) else "unknown"
            messages = request_data.get("messages") if isinstance(request_data, dict) else None
            err_str = str(original_exception)
            err_analysis = parse_error_cause(original_exception, err_str)

            entry = {
                "id": call_id,
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "status": "error",
                "status_code": err_analysis["status_code"],
                "model": model,
                "latency_ms": 0,
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                "messages": messages,
                "response": None,
                "error": {
                    "category": err_analysis["category"],
                    "type": type(original_exception).__name__ if original_exception else "ProxyException",
                    "message": err_str,
                    "cause": err_analysis["cause"],
                    "suggested_action": err_analysis["suggested_action"]
                }
            }
            write_log_entry(entry)
        except Exception as e:
            print(f"[AuditLogger Error] Trong async_post_call_failure_hook: {e}")

proxy_logger = AuditLogger()
