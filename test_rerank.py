import os
import requests
import json

# Test script cho BAAI/bge-reranker-v2-m3 trên vLLM & LiteLLM

VLLM_DIRECT_URL = os.environ.get("VLLM_RERANK_URL", "http://localhost:8005/v1/rerank")
LITELLM_URL = os.environ.get("LITELLM_RERANK_URL", "http://localhost:4000/v1/rerank")
LITELLM_API_KEY = os.environ.get("LITELLM_MASTER_KEY", "your-litellm-master-key")

query = "Thủ đô của Việt Nam là gì và có những di tích lịch sử nào nổi tiếng?"

documents = [
    "Hà Nội là thủ đô của nước Cộng hòa Xã hội Chủ nghĩa Việt Nam, nổi tiếng với Hồ Gươm, Văn Miếu Quốc Tử Giám và Lăng Chủ tịch Hồ Chí Minh.",
    "Thành phố Hồ Chí Minh là trung tâm kinh tế, tài chính và công nghiệp lớn nhất của Việt Nam, trước đây có tên là Sài Gòn.",
    "Đà Nẵng là một thành phố trực thuộc trung ương tại vùng Duyên hải Nam Trung Bộ Việt Nam, nổi tiếng với Bán đảo Sơn Trà và Cầu Vàng.",
    "Phở là món ăn truyền thống đặc trưng của ẩm thực Việt Nam, được nấu từ nước dùng hầm xương cùng các loại gia vị quế hồi thảo quả.",
    "Văn Miếu – Quốc Tử Giám là trường đại học đầu tiên của Việt Nam, nằm ở quận Đống Đa, thành phố Hà Nội."
]

payload = {
    "model": "BAAI/bge-reranker-v2-m3",
    "query": query,
    "documents": documents,
    "top_n": 3
}

def test_rerank(url: str, name: str, headers: dict = None):
    print(f"\n==========================================")
    print(f"Testing {name} tại: {url}")
    print(f"Query: {query}")
    print(f"==========================================")
    
    req_headers = {"Content-Type": "application/json"}
    if headers:
        req_headers.update(headers)
        
    try:
        response = requests.post(url, headers=req_headers, json=payload, timeout=30)
        if response.status_code == 200:
            result = response.json()
            print("Kết quả Reranking thành công:")
            for item in result.get("results", []):
                idx = item.get("index")
                score = item.get("relevance_score")
                doc_text = documents[idx]
                print(f"- [Rank {idx} | Score: {score:.4f}]: {doc_text[:80]}...")
        else:
            print(f"Thất bại ({response.status_code}): {response.text}")
    except Exception as e:
        print(f"Lỗi kết nối tới {name}: {e}")

if __name__ == "__main__":
    # 1. Test trực tiếp container vLLM reranker (Port 8005)
    test_rerank(VLLM_DIRECT_URL, "vLLM Reranker Trực tiếp")

    # 2. Test qua LiteLLM Gateway (Port 4000)
    test_rerank(LITELLM_URL, "LiteLLM Gateway", headers={"Authorization": f"Bearer {LITELLM_API_KEY}"})
