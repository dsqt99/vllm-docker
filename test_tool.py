import requests
import json
import os

url = "http://localhost:4000/v1/chat/completions"
api_key = "sk-1ca0e61277cf6d63d758b6597d27602511aa48c22b2f3936cde07406e7babeae"

headers = {
    "Content-Type": "application/json",
    "Authorization": f"Bearer {api_key}"
}

data = {
    "model": "qwen-3.6-27b",
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
    ],
    "tool_choice": "auto"
}

print("Sending request to LiteLLM...")
response = requests.post(url, headers=headers, json=data)

if response.status_code == 200:
    print("Success! Response:")
    print(json.dumps(response.json(), indent=2))
else:
    print(f"Error {response.status_code}: {response.text}")
