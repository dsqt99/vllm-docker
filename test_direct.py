import requests
import json

url = "http://localhost:8000/v1/chat/completions"

headers = {
    "Content-Type": "application/json",
}

data = {
    "model": "Qwen/Qwen3.5-9B",
    "messages": [
        {"role": "user", "content": "What's the weather like in Boston today?"}
    ],
    "tools": [
        {
            "type": "function",
            "function": {
                "name": "get_current_weather",
                "description": "Get the current weather in a given location",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "location": {
                            "type": "string",
                            "description": "The city and state, e.g. San Francisco, CA",
                        },
                        "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]},
                    },
                    "required": ["location"],
                },
            },
        }
    ]
}

print("Sending request to vLLM directly...")
response = requests.post(url, headers=headers, json=data)

if response.status_code == 200:
    print("Success! Response:")
    print(json.dumps(response.json(), indent=2))
else:
    print(f"Error {response.status_code}: {response.text}")
