import os
import requests
import json

BASE_URL = os.environ.get("LITELLM_URL", "http://localhost:4000/v1")
MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "your-litellm-master-key")

headers = {
    "Authorization": f"Bearer {MASTER_KEY}",
    "Content-Type": "application/json"
}

def test_systemone_endpoint():
    print("=" * 60)
    print("1. Testing /v1/systemone (Structured Decisions) Endpoint")
    print("=" * 60)
    url = f"{BASE_URL}/systemone"
    
    payload = {
        "model": "Qwen/Qwen3.5-9B",
        "state": {
            "ticket": "Khách hàng thông báo đơn hàng #9821 bị trừ tiền 2 lần nhưng chưa nhận được email xác nhận."
        },
        "questions": {
            "department": {
                "type": "choice",
                "instructions": "Phòng ban nào nên xử lý khiếu nại này?",
                "criteria": {
                    "billing": "Vấn đề thanh toán, hoàn tiền, trừ tiền",
                    "delivery": "Vấn đề vận chuyển hàng hóa",
                    "technical": "Lỗi kỹ thuật hệ thống, tài khoản"
                }
            },
            "urgent": {
                "type": "noul",
                "instructions": "Vấn đề này có cần giải quyết khẩn cấp trong 1 giờ không?",
                "criteria": {
                    "true": "Giao dịch tài chính hoặc mất tiền"
                }
            },
            "customer_mood": {
                "type": "score",
                "instructions": "Mức độ bức xúc của khách hàng?",
                "criteria": ["bình thường", "khó chịu", "rất tức giận"]
            }
        },
        "chat_template_kwargs": {
            "enable_thinking": False
        }
    }
    
    try:
        response = requests.post(url, headers=headers, json=payload, timeout=30)
        print(f"Status Code: {response.status_code}")
        print("Response Body:")
        print(json.dumps(response.json(), indent=2, ensure_ascii=False))
    except Exception as e:
        print(f"Error testing /v1/systemone: {e}")

def test_decisions_endpoint():
    print("\n" + "=" * 60)
    print("2. Testing /v1/decisions (OpenAI Decisions Spec) Endpoint")
    print("=" * 60)
    url = f"{BASE_URL}/decisions"
    
    payload = {
        "model": "Qwen/Qwen3.5-9B",
        "input": "Hàng gửi đến bị vỡ màn hình trong quá trình vận chuyển.",
        "questions": [
            {
                "type": "predicate",
                "name": "damaged",
                "instructions": "Khách hàng có báo cáo hàng bị hư hỏng không?"
            },
            {
                "type": "choice",
                "name": "department",
                "instructions": "Bộ phận nào sẽ tiếp nhận?",
                "choices": [
                    {"value": "returns", "description": "Bộ phận đổi trả bảo hành"},
                    {"value": "billing", "description": "Bộ phận kế toán"}
                ]
            },
            {
                "type": "score",
                "name": "severity",
                "instructions": "Mức độ hư hỏng nặng hay nhẹ?",
                "levels": [
                    {"label": "trầy xước nhẹ"},
                    {"label": "hỏng nặng hoặc vỡ nát"}
                ]
            }
        ]
    }
    
    try:
        response = requests.post(url, headers=headers, json=payload, timeout=30)
        print(f"Status Code: {response.status_code}")
        print("Response Body:")
        print(json.dumps(response.json(), indent=2, ensure_ascii=False))
    except Exception as e:
        print(f"Error testing /v1/decisions: {e}")

if __name__ == "__main__":
    test_systemone_endpoint()
    test_decisions_endpoint()
