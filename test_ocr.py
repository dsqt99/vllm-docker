import base64
import io
import requests
import json
from PIL import Image, ImageDraw, ImageFont

def generate_sample_document_image() -> str:
    """Tạo một ảnh tài liệu mẫu có chữ tiếng Việt thực tế để test OCR."""
    width, height = 800, 260
    img = Image.new("RGB", (width, height), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    
    font_path = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
    try:
        font = ImageFont.truetype(font_path, 26)
    except Exception:
        font = ImageFont.load_default()

    draw.text((30, 30), "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM", fill=(0, 0, 0), font=font)
    draw.text((30, 85), "Độc lập - Tự do - Hạnh phúc", fill=(0, 0, 0), font=font)
    draw.text((30, 145), "HÓA ĐƠN TIỀN ĐIỆN THÁNG 10/2026", fill=(0, 0, 0), font=font)
    draw.text((30, 200), "Số tiền thanh toán: 1.250.000 VNĐ", fill=(0, 0, 0), font=font)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")

def test_ocr():
    print("--> Đang tạo ảnh tài liệu mẫu (tiếng Việt có dấu)...")
    b64_img = generate_sample_document_image()

    prompt = "OCR:"
    
    payload = {
        "model": "senocr-vi",
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{b64_img}"
                        }
                    },
                    {
                        "type": "text",
                        "text": prompt
                    }
                ]
            }
        ],
        "max_tokens": 1024,
        "temperature": 0.0
    }

    # 1. Trực tiếp port 8007
    print("\n--> [1] Testing SenOCR-Vi trực tiếp tại http://localhost:8007/v1/chat/completions...")
    res = requests.post("http://localhost:8007/v1/chat/completions", json=payload)
    print("Status:", res.status_code)
    if res.status_code == 200:
        content = res.json()["choices"][0]["message"]["content"]
        print("KẾT QUẢ OCR:")
        print(content)
    else:
        print(res.text)

    # 2. Qua LiteLLM Gateway port 4000
    print("\n--> [2] Testing SenOCR-Vi qua LiteLLM Gateway http://localhost:4000/v1/chat/completions...")
    headers = {
        "Authorization": "Bearer sk-1ca0e61277cf6d63d758b6597d27602511aa48c22b2f3936cde07406e7babeae",
        "Content-Type": "application/json"
    }
    res_gateway = requests.post("http://localhost:4000/v1/chat/completions", headers=headers, json=payload)
    print("Status:", res_gateway.status_code)
    if res_gateway.status_code == 200:
        content = res_gateway.json()["choices"][0]["message"]["content"]
        print("KẾT QUẢ OCR QUA GATEWAY:")
        print(content)
    else:
        print(res_gateway.text)

if __name__ == "__main__":
    test_ocr()
