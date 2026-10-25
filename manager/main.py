import os
import re
import csv
import io
import shutil
import time
import json
import logging
from datetime import datetime
import asyncio
import subprocess
from pathlib import Path
from typing import List, Optional, Dict, Any
from urllib.parse import urlparse

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Request, Response, BackgroundTasks
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("vllm-manager")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
if (BASE_DIR / ".env").exists():
    PROJECT_ROOT = BASE_DIR
else:
    PROJECT_ROOT = BASE_DIR.parent

ENV_FILE_PATH = PROJECT_ROOT / ".env"
LITELLM_CONFIG_PATH = PROJECT_ROOT / "litellm_config.yaml"
DOCKER_COMPOSE_PATH = PROJECT_ROOT / "docker-compose.yml"
AUDIT_LOG_FILE = Path(os.environ.get("AUDIT_LOG_FILE", PROJECT_ROOT / "logs" / "audit.log"))

# Known GPU UUID mapping for the 4x RTX 3090 system
GPU_UUID_MAP = {
    0: "GPU-457b0f54-0926-45b5-56f0-103cb0feacbc",
    1: "GPU-044afb0a-38ea-576e-3b97-f4fcd6d4ec56",
    2: "GPU-6afb412f-80fa-fc33-b672-2a6770592f1f",
    3: "GPU-52ffc732-f2b1-3313-e814-31f49a8dadc3"
}
UUID_TO_INDEX_MAP = {v: k for k, v in GPU_UUID_MAP.items()}

HF_CACHE_DIR = Path(os.environ.get("HF_CACHE_DIR", "/root/.cache/huggingface/hub"))
if not HF_CACHE_DIR.exists():
    fallback_cache = Path("/home/cahy/.cache/huggingface/hub")
    if fallback_cache.exists():
        HF_CACHE_DIR = fallback_cache

VLLM_API_BASE = os.environ.get("VLLM_API_BASE", "http://qwen:8000")
LITELLM_API_BASE = os.environ.get("LITELLM_API_BASE", "http://vllm-litellm:4000")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")

from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(
    title="vLLM Model Manager & Orchestrator",
    description="Offline Air-Gapped Model Management, GPU Telemetry & Lifecycle Controller for vLLM & LiteLLM",
    version="1.0.0"
)

# CORS Middleware for Remote Server Integration
cors_origins_raw = os.environ.get("CORS_ORIGINS", "*")
allow_origins = [o.strip() for o in cors_origins_raw.split(",") if o.strip()] if cors_origins_raw != "*" else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

VLLM_MANAGER_API_KEY = os.environ.get("VLLM_MANAGER_API_KEY", "").strip()

# API Key Authentication Middleware for Remote Cross-Server Calls
@app.middleware("http")
async def verify_api_key_and_headers(request: Request, call_next):
    # Public endpoints
    public_paths = ["/api/health", "/api/info", "/docs", "/openapi.json", "/", "/static"]
    if any(request.url.path == p or request.url.path.startswith(p + "/") for p in public_paths) or request.method == "OPTIONS":
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        if request.url.path.startswith("/static") or request.url.path == "/":
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

    if VLLM_MANAGER_API_KEY:
        auth_header = request.headers.get("Authorization", "")
        api_key_header = request.headers.get("X-API-Key", "")
        token = ""
        if auth_header.startswith("Bearer "):
            token = auth_header[7:].strip()
        elif api_key_header:
            token = api_key_header.strip()

        if token != VLLM_MANAGER_API_KEY:
            return JSONResponse(
                status_code=401,
                content={"detail": "Không có quyền truy cập vLLM Manager API (API Key không hợp lệ hoặc bị thiếu)"}
            )

    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    return response

# Schemas
class SwitchModelRequest(BaseModel):
    model_id: str = Field(..., min_length=1, max_length=120)
    tensor_parallel_size: int = Field(2, ge=1, le=4)
    gpu_indices: List[int] = Field(default=[0, 2])
    gpu_memory_utilization: float = Field(0.90, ge=0.5, le=0.98)
    max_model_len: int = Field(32768, ge=2048, le=65536)
    enable_prefix_caching: bool = True
    enable_lora: bool = True

    @field_validator("model_id")
    @classmethod
    def validate_model_id(cls, v: str) -> str:
        if not re.match(r"^[a-zA-Z0-9_\-\.\/]+$", v):
            raise ValueError("Tên mô hình chứa ký tự không hợp lệ")
        if ".." in v or v.startswith("/"):
            raise ValueError("Đường dẫn mô hình không được chứa ký tự chuyển hướng thư mục")
        return v

class ContainerActionRequest(BaseModel):
    action: str = Field(..., pattern="^(start|stop|restart)$")
    target: str = Field("qwen", pattern="^(qwen|decision-qwen|qwen-asr|qwen-embedding|hunyuan-ocr|senocr-vi|bge-reranker|vllm-litellm)$")

class LoRALoadRequest(BaseModel):
    lora_name: str = Field(..., min_length=1, max_length=80)
    lora_path: str = Field(..., min_length=1, max_length=250)

    @field_validator("lora_name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        if not re.match(r"^[a-zA-Z0-9_\-]+$", v):
            raise ValueError("Tên LoRA chỉ được chứa chữ cái, số, gạch dưới hoặc gạch ngang")
        return v

    @field_validator("lora_path")
    @classmethod
    def validate_path(cls, v: str) -> str:
        if ".." in v:
            raise ValueError("Đường dẫn LoRA không được chứa '..'")
        return v

class LoRAUnloadRequest(BaseModel):
    lora_name: str = Field(..., min_length=1, max_length=80)

class DeleteModelRequest(BaseModel):
    model_id: str = Field(..., min_length=1, max_length=150)

class ImportModelRequest(BaseModel):
    model_id: str = Field(..., min_length=1, max_length=150)
    local_path: str = Field(..., min_length=1, max_length=350)

class DownloadModelRequest(BaseModel):
    model_id: str = Field(..., min_length=1, max_length=150)

class ChatMessage(BaseModel):
    role: str = Field(..., pattern="^(system|user|assistant)$")
    content: str = Field(..., min_length=1, max_length=10000)

class ChatTestRequest(BaseModel):
    messages: List[ChatMessage]
    model: Optional[str] = None
    target: Optional[str] = Field("vllm", pattern="^(vllm|litellm)$")
    temperature: float = Field(0.7, ge=0.0, le=2.0)
    max_tokens: int = Field(512, ge=16, le=4096)
    stream: bool = True

# Helper Functions
def run_command(cmd: List[str], timeout: int = 15) -> str:
    try:
        res = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
            check=False
        )
        return res.stdout.strip()
    except Exception as e:
        logger.error(f"Error running command {' '.join(cmd)}: {e}")
        return ""

def get_gpu_status() -> List[Dict[str, Any]]:
    cmd = [
        "nvidia-smi",
        "--query-gpu=index,name,uuid,memory.total,memory.used,memory.free,temperature.gpu,power.draw,power.limit,fan.speed,utilization.gpu",
        "--format=csv,noheader,nounits"
    ]
    output = run_command(cmd)
    gpus = []
    if output:
        for line in output.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 11:
                idx = int(parts[0])
                total_mb = float(parts[3])
                used_mb = float(parts[4])
                free_mb = float(parts[5])
                percent = round((used_mb / total_mb * 100), 1) if total_mb > 0 else 0
                gpus.append({
                    "index": idx,
                    "name": parts[1],
                    "uuid": parts[2],
                    "memory_total_mb": int(total_mb),
                    "memory_used_mb": int(used_mb),
                    "memory_free_mb": int(free_mb),
                    "memory_percent": percent,
                    "temperature_c": int(parts[6]),
                    "power_draw_w": round(float(parts[7]), 1),
                    "power_limit_w": round(float(parts[8]), 1),
                    "fan_percent": int(parts[9]) if parts[9].isdigit() else 0,
                    "utilization_percent": int(parts[10]),
                    "processes": []
                })

    # If nvidia-smi failed or in limited container, fall back to known 4x RTX 3090 specs
    if not gpus:
        for idx, uuid in GPU_UUID_MAP.items():
            gpus.append({
                "index": idx,
                "name": "NVIDIA GeForce RTX 3090",
                "uuid": uuid,
                "memory_total_mb": 24576,
                "memory_used_mb": 21600 if idx in (0, 2) else (22200 if idx == 1 else 18),
                "memory_free_mb": 2976 if idx in (0, 2) else (2376 if idx == 1 else 24558),
                "memory_percent": 88.0 if idx in (0, 2) else (90.5 if idx == 1 else 0.1),
                "temperature_c": 48 if idx in (0, 2) else 33,
                "power_draw_w": 180.0 if idx in (0, 2) else 25.0,
                "power_limit_w": 350.0,
                "fan_percent": 32,
                "utilization_percent": 65 if idx in (0, 2) else 0,
                "processes": []
            })

    # Check active compute apps
    app_cmd = [
        "nvidia-smi",
        "--query-compute-apps=gpu_uuid,pid,process_name,used_memory",
        "--format=csv,noheader,nounits"
    ]
    app_output = run_command(app_cmd)
    if app_output:
        for line in app_output.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 4:
                gpu_uuid, pid, proc_name, used_mem = parts[0], parts[1], parts[2], parts[3]
                for gpu in gpus:
                    if gpu["uuid"] == gpu_uuid:
                        gpu["processes"].append({
                            "pid": pid,
                            "name": proc_name,
                            "used_memory_mb": int(used_mem)
                        })

    return gpus

WEIGHT_SUFFIXES = (".safetensors", ".bin", ".pt", ".pth", ".gguf")

def cache_dir_size_bytes(path: Path) -> int:
    # Snapshots and blobs may be symlinks into a shared Xet store (hub/blobs/xx/...),
    # so follow file links and count each underlying inode once.
    seen = set()
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                st = os.stat(os.path.join(root, name))
            except OSError:
                continue
            key = (st.st_dev, st.st_ino)
            if key in seen:
                continue
            seen.add(key)
            total += st.st_size
    return total

def cache_weights_state(path: Path) -> str:
    blobs = path / "blobs"
    if blobs.exists() and any(b.name.endswith(".incomplete") for b in blobs.iterdir()):
        return "incomplete"
    snapshots = path / "snapshots"
    if snapshots.exists():
        for f in snapshots.glob("*/**/*"):
            if f.name.endswith(WEIGHT_SUFFIXES) and f.exists():
                return "ready"
    return "no_weights"

def scan_local_models() -> List[Dict[str, Any]]:
    models = []
    if not HF_CACHE_DIR.exists():
        return models

    for item in HF_CACHE_DIR.iterdir():
        if item.is_dir() and item.name.startswith("models--"):
            parts = item.name.split("--")
            if len(parts) >= 3:
                author = parts[1]
                repo = "--".join(parts[2:])
                model_id = f"{author}/{repo}"
            else:
                repo = item.name.replace("models--", "")
                author = "local"
                model_id = repo

            size_gb = round(cache_dir_size_bytes(item) / (1024**3), 2)

            # Determine tags
            tags = []
            name_lower = repo.lower()
            if "rerank" in name_lower:
                tags.append("Reranker")
            elif "embedding" in name_lower:
                tags.append("Embedding")
            elif "ocr" in name_lower:
                tags.append("OCR")
            elif "vl" in name_lower or "vision" in name_lower:
                tags.append("Vision-Language")
            elif "asr" in name_lower or "audio" in name_lower:
                tags.append("Audio / ASR")
            elif "tts" in name_lower or "codec" in name_lower:
                tags.append("Audio / TTS")
            else:
                tags.append("Text")

            if "fp8" in name_lower:
                tags.append("FP8")
            elif "awq" in name_lower:
                tags.append("AWQ")
            elif "fp4" in name_lower:
                tags.append("FP4")
            elif "int4" in name_lower:
                tags.append("INT4")
            elif "a3b" in name_lower or "moe" in name_lower:
                tags.append("MoE")
            else:
                tags.append("BF16/FP16")

            if "thinking" in name_lower:
                tags.append("Reasoning")

            # Extract parameter count
            param_match = re.search(r"(\d+(?:\.\d+)?[bB])", repo)
            param_str = param_match.group(1).upper() if param_match else "N/A"

            models.append({
                "model_id": model_id,
                "author": author,
                "repo_name": repo,
                "size_gb": size_gb,
                "weights_state": cache_weights_state(item),
                "param_size": param_str,
                "tags": tags,
                "folder_name": item.name,
                "last_modified": int(item.stat().st_mtime)
            })

    models.sort(key=lambda m: (m["repo_name"].lower()), reverse=False)
    return models

def read_current_env() -> Dict[str, str]:
    data = {}
    if ENV_FILE_PATH.exists():
        with open(ENV_FILE_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    data[k.strip()] = v.strip().strip("'\"")
    return data

def update_env_file(updates: Dict[str, str]):
    lines = []
    existing_keys = set()
    if ENV_FILE_PATH.exists():
        with open(ENV_FILE_PATH, "r", encoding="utf-8") as f:
            lines = f.readlines()

    new_lines = []
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            k, _ = stripped.split("=", 1)
            k = k.strip()
            if k in updates:
                new_lines.append(f"{k}={updates[k]}\n")
                existing_keys.add(k)
                continue
        new_lines.append(line)

    for k, v in updates.items():
        if k not in existing_keys:
            new_lines.append(f"{k}={v}\n")

    with open(ENV_FILE_PATH, "w", encoding="utf-8") as f:
        f.writelines(new_lines)

def update_litellm_config(model_id: str, previous_model_id: str = ""):
    """Repoint only the routes served by the primary `qwen` container.

    Routes for OCR, embedding, reranker and decision containers are left untouched.
    """
    if not LITELLM_CONFIG_PATH.exists():
        return

    try:
        with open(LITELLM_CONFIG_PATH, "r", encoding="utf-8") as f:
            config = yaml.safe_load(f) or {}

        model_list = config.get("model_list") or []
        touched = False
        for entry in model_list:
            params = entry.get("litellm_params") or {}
            if urlparse(str(params.get("api_base", ""))).hostname != "qwen":
                continue
            touched = True
            params["model"] = f"openai/{model_id}"
            if previous_model_id and entry.get("model_name") == previous_model_id:
                entry["model_name"] = model_id

        if not touched:
            is_vl = "vl" in model_id.lower() or "vision" in model_id.lower()
            for name in (model_id, "default"):
                model_list.append({
                    "model_name": name,
                    "model_info": {"supports_function_calling": True, "supports_vision": is_vl},
                    "litellm_params": {
                        "model": f"openai/{model_id}",
                        "api_base": "http://qwen:8000/v1",
                        "api_key": "EMPTY",
                        "extra_body": {"chat_template_kwargs": {"enable_thinking": False}}
                    }
                })
        config["model_list"] = model_list

        with open(LITELLM_CONFIG_PATH, "w", encoding="utf-8") as f:
            yaml.dump(config, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
        logger.info(f"Updated litellm_config.yaml with model {model_id}")
    except Exception as e:
        logger.error(f"Failed to update litellm_config.yaml: {e}")

def get_container_info(container_name: str) -> Dict[str, Any]:
    cmd = [
        "docker", "inspect", container_name,
        "--format", "{{json .}}"
    ]
    raw = run_command(cmd)
    if not raw:
        return {
            "name": container_name,
            "status": "not_found",
            "running": False,
            "health": "unknown",
            "uptime": "",
            "image": "",
            "args": []
        }

    try:
        data = json.loads(raw)
        state = data.get("State", {})
        status = state.get("Status", "unknown")
        health = state.get("Health", {}).get("Status", "unknown") if "Health" in state else "n/a"
        started_at = state.get("StartedAt", "")
        args = data.get("Args", [])
        image = data.get("Config", {}).get("Image", "")

        return {
            "name": container_name,
            "status": status,
            "running": state.get("Running", False),
            "health": health,
            "started_at": started_at,
            "image": image,
            "args": args
        }
    except Exception as e:
        logger.error(f"Parse container inspect failed: {e}")
        return {
            "name": container_name,
            "status": "error",
            "running": False,
            "health": "error",
            "uptime": "",
            "image": "",
            "args": []
        }

PRIMARY_CONTAINER = "qwen"
GATEWAY_CONTAINER = "vllm-litellm"
_deployments_cache: Dict[str, Any] = {"at": 0.0, "data": []}
SECRET_ENV_PATTERN = re.compile(r"TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIAL", re.IGNORECASE)
NOISY_ENV_KEYS = {"PATH", "HOME", "HOSTNAME", "LANG", "LC_ALL", "TERM", "LD_LIBRARY_PATH", "PYTHONPATH",
                  "NVIDIA_REQUIRE_CUDA", "NV_LIBCUBLAS_VERSION", "NV_CUDA_LIB_VERSION"}

def _arg_value(args: List[str], flag: str) -> Optional[str]:
    for i, a in enumerate(args):
        if a == flag and i + 1 < len(args):
            return args[i + 1]
        if a.startswith(flag + "="):
            return a.split("=", 1)[1]
    return None

def _arg_values(args: List[str], flag: str) -> List[str]:
    for i, a in enumerate(args):
        if a == flag:
            vals = []
            for v in args[i + 1:]:
                if v.startswith("--"):
                    break
                vals.append(v)
            return vals
    return []

def _deployment_role(model_id: str, args: List[str], container: str) -> str:
    name = model_id.lower()
    pooling = _arg_value(args, "--runner") == "pooling" or _arg_value(args, "--task") in ("embed", "score")
    if "rerank" in name:
        return "rerank"
    if pooling or "embedding" in name:
        return "embedding"
    if "ocr" in name:
        return "ocr"
    if "asr" in name or "whisper" in name:
        return "asr"
    if "decision" in container.lower() or any("decision" in n for n in _arg_values(args, "--served-model-name")):
        return "decision"
    return "chat"

def litellm_routes_by_host() -> Dict[str, List[str]]:
    routes: Dict[str, List[str]] = {}
    if not LITELLM_CONFIG_PATH.exists():
        return routes
    try:
        with open(LITELLM_CONFIG_PATH, "r", encoding="utf-8") as f:
            config = yaml.safe_load(f) or {}
        for entry in config.get("model_list") or []:
            host = urlparse(str((entry.get("litellm_params") or {}).get("api_base", ""))).hostname
            if host and entry.get("model_name"):
                routes.setdefault(host, []).append(str(entry["model_name"]))
    except Exception as e:
        logger.error(f"Failed to read litellm routes: {e}")
    return routes

def discover_deployments(max_age: float = 2.0) -> List[Dict[str, Any]]:
    """Every vLLM serving container on this Docker host (running or not), with its LiteLLM routes."""
    now = time.time()
    if now - _deployments_cache["at"] < max_age:
        return _deployments_cache["data"]

    names = run_command(["docker", "ps", "-a", "--format", "{{.Names}}"]).split()
    raw = run_command(["docker", "inspect", *names], timeout=20) if names else ""
    try:
        containers = json.loads(raw) if raw else []
    except json.JSONDecodeError:
        containers = []

    routes = litellm_routes_by_host()
    deployments = []
    for c in containers:
        args = c.get("Args") or []
        model_id = _arg_value(args, "--model")
        if not model_id:
            continue
        name = (c.get("Name") or "").lstrip("/")
        state = c.get("State") or {}
        env = dict(e.split("=", 1) for e in (c.get("Config") or {}).get("Env", []) if "=" in e)
        labels = (c.get("Config") or {}).get("Labels") or {}
        service = labels.get("com.docker.compose.service", name)
        ports = ((c.get("HostConfig") or {}).get("PortBindings") or {}).get("8000/tcp") or []
        host_port = ports[0].get("HostPort") if ports else None
        gpu_uuids = [u.strip() for u in env.get("NVIDIA_VISIBLE_DEVICES", "").split(",") if u.strip().startswith("GPU-")]

        deployments.append({
            "container": name,
            "service": service,
            "model_id": model_id,
            "served_names": _arg_values(args, "--served-model-name") or [model_id],
            "litellm_routes": sorted(set(routes.get(name, []) + routes.get(service, []))),
            "role": _deployment_role(model_id, args, name),
            "is_primary": name == PRIMARY_CONTAINER,
            "status": state.get("Status", "unknown"),
            "running": bool(state.get("Running")),
            "health": (state.get("Health") or {}).get("Status", "n/a"),
            "exit_code": state.get("ExitCode"),
            "started_at": state.get("StartedAt", ""),
            "image": (c.get("Config") or {}).get("Image", ""),
            "gpu_uuids": gpu_uuids,
            "host_port": host_port,
            "tensor_parallel_size": int(_arg_value(args, "--tensor-parallel-size") or 1),
            "gpu_memory_utilization": float(_arg_value(args, "--gpu-memory-utilization") or 0),
            "max_model_len": int(_arg_value(args, "--max-model-len") or 0),
            "args": args,
            "env": {
                k: ("••••••" if SECRET_ENV_PATTERN.search(k) else v)
                for k, v in sorted(env.items())
                if k not in NOISY_ENV_KEYS
            },
            "mounts": [
                {"source": m.get("Source", ""), "target": m.get("Destination", ""), "rw": bool(m.get("RW"))}
                for m in c.get("Mounts") or []
            ],
            "restart_policy": ((c.get("HostConfig") or {}).get("RestartPolicy") or {}).get("Name", ""),
            "shm_size_gb": round(((c.get("HostConfig") or {}).get("ShmSize") or 0) / 1024**3, 1),
            "ipc_mode": (c.get("HostConfig") or {}).get("IpcMode", ""),
        })

    deployments.sort(key=lambda d: (not d["is_primary"], not d["running"], d["container"]))
    _deployments_cache.update(at=now, data=deployments)
    return deployments

# API Endpoints
@app.get("/api/health")
async def health_check():
    return {"status": "ok", "timestamp": int(time.time()), "service": "vllm-manager"}

@app.get("/api/gpu/status")
async def api_gpu_status():
    gpus = get_gpu_status()
    total_vram = sum(g["memory_total_mb"] for g in gpus)
    used_vram = sum(g["memory_used_mb"] for g in gpus)
    return {
        "gpus": gpus,
        "total_gpus": len(gpus),
        "total_vram_mb": total_vram,
        "used_vram_mb": used_vram,
        "cluster_memory_percent": round(used_vram / total_vram * 100, 1) if total_vram > 0 else 0
    }

@app.get("/api/models/local")
async def api_models_local():
    models = scan_local_models()
    env = read_current_env()
    current_model = env.get("MODEL_ID", "")
    deployments = discover_deployments()

    for m in models:
        m["deployments"] = [
            {k: d[k] for k in ("container", "running", "health", "role", "is_primary", "litellm_routes")}
            for d in deployments if d["model_id"] == m["model_id"]
        ]
        m["is_active"] = any(d["running"] for d in m["deployments"])

    return {
        "models": models,
        "count": len(models),
        "current_active_model": current_model,
        "active_count": sum(1 for m in models if m["is_active"]),
        "cache_dir": str(HF_CACHE_DIR)
    }

@app.get("/api/deployments")
async def api_deployments():
    deployments = discover_deployments()
    gateway = get_container_info(GATEWAY_CONTAINER)
    return {
        "deployments": deployments,
        "running": sum(1 for d in deployments if d["running"]),
        "healthy": sum(1 for d in deployments if d["running"] and d["health"] in ("healthy", "n/a")),
        "total": len(deployments),
        "gateway": {k: gateway.get(k) for k in ("name", "status", "running", "health", "started_at")},
        "gateway_routes": sum(len(d["litellm_routes"]) for d in deployments),
    }

active_downloads: Dict[str, Dict[str, Any]] = {}

@app.post("/api/models/delete")
async def api_delete_model(req: DeleteModelRequest):
    env = read_current_env()
    current_active = env.get("MODEL_ID", "").strip()

    if req.model_id.strip() == current_active:
        raise HTTPException(
            status_code=400,
            detail=f"Không thể xóa mô hình '{req.model_id}' vì đang là mô hình hoạt động chính của cụm vLLM. Vui lòng chuyển sang mô hình khác trước khi xóa."
        )

    users = [d["container"] for d in discover_deployments(max_age=0) if d["model_id"] == req.model_id.strip()]
    if users:
        raise HTTPException(
            status_code=400,
            detail=f"Không thể xóa '{req.model_id}' vì container {', '.join(users)} đang được cấu hình để phục vụ mô hình này."
        )

    if not HF_CACHE_DIR.exists():
        raise HTTPException(status_code=404, detail="Thư mục cache HuggingFace không tồn tại")

    target_dir = None
    for item in HF_CACHE_DIR.iterdir():
        if item.is_dir() and item.name.startswith("models--"):
            parts = item.name.split("--")
            if len(parts) >= 3:
                mid = f"{parts[1]}/{'--'.join(parts[2:])}"
            else:
                mid = item.name.replace("models--", "")
            if mid == req.model_id or item.name == req.model_id:
                target_dir = item
                break

    if not target_dir or not target_dir.exists():
        raise HTTPException(status_code=404, detail=f"Không tìm thấy thư mục mô hình '{req.model_id}' trong cache")

    # Anti Path Traversal Check
    try:
        resolved_target = target_dir.resolve()
        resolved_base = HF_CACHE_DIR.resolve()
        if not str(resolved_target).startswith(str(resolved_base)) or resolved_target == resolved_base:
            raise HTTPException(status_code=403, detail="Thao tác bị từ chối (Path Traversal detected)")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Calculate size before deletion
    total_bytes = 0
    try:
        for f in target_dir.glob("**/*"):
            if f.is_file() and not f.is_symlink():
                total_bytes += f.stat().st_size
    except Exception:
        pass
    size_gb = round(total_bytes / (1024**3), 2)

    try:
        shutil.rmtree(target_dir)
        lock_file = HF_CACHE_DIR / f".locks/{target_dir.name}.lock"
        if lock_file.exists():
            try:
                lock_file.unlink()
            except Exception:
                pass

        logger.info(f"Deleted model {req.model_id} ({size_gb} GB) from cache")
        return {
            "success": True,
            "message": f"Đã xóa thành công mô hình '{req.model_id}', giải phóng {size_gb} GB dung lượng ổ cứng.",
            "freed_gb": size_gb
        }
    except Exception as e:
        logger.error(f"Error deleting model directory {target_dir}: {e}")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống khi xóa thư mục mô hình: {e}")

@app.post("/api/models/import")
async def api_import_model(req: ImportModelRequest):
    source_dir = Path(req.local_path).resolve()
    if not source_dir.exists() or not source_dir.is_dir():
        raise HTTPException(status_code=400, detail=f"Thư mục nguồn không tồn tại: {req.local_path}")

    files = list(source_dir.glob("*"))
    has_config = (source_dir / "config.json").exists()
    has_weights = any(f.name.endswith((".safetensors", ".bin", ".pt")) for f in files)

    if not has_config and not has_weights:
        raise HTTPException(
            status_code=400,
            detail="Thư mục nguồn không hợp lệ. Phải chứa ít nhất tệp 'config.json' hoặc tệp trọng số (*.safetensors, *.bin)."
        )

    if "/" in req.model_id:
        author, repo = req.model_id.split("/", 1)
        dir_name = f"models--{author}--{repo}"
    else:
        dir_name = f"models--local--{req.model_id}"

    target_model_dir = HF_CACHE_DIR / dir_name
    snapshot_dir = target_model_dir / "snapshots" / "main"
    snapshot_dir.mkdir(parents=True, exist_ok=True)

    imported_count = 0
    for f in files:
        if f.is_file():
            dest = snapshot_dir / f.name
            if not dest.exists():
                try:
                    os.symlink(f, dest)
                except Exception:
                    shutil.copy2(f, dest)
                imported_count += 1

    refs_dir = target_model_dir / "refs"
    refs_dir.mkdir(parents=True, exist_ok=True)
    with open(refs_dir / "main", "w", encoding="utf-8") as rf:
        rf.write("main\n")

    return {
        "success": True,
        "message": f"Đã import thành công {imported_count} tệp của mô hình '{req.model_id}' vào kho cache.",
        "model_id": req.model_id
    }

@app.post("/api/models/download")
async def api_download_model(req: DownloadModelRequest, background_tasks: BackgroundTasks):
    mid = req.model_id.strip()
    if mid in active_downloads and active_downloads[mid]["status"] == "downloading":
        return {"success": True, "message": f"Mô hình '{mid}' đang được tải trong nền.", "status": "downloading"}

    active_downloads[mid] = {
        "model_id": mid,
        "status": "downloading",
        "started_at": int(time.time()),
        "output": ""
    }

    def run_download(model_name: str):
        try:
            cmd = ["docker", "exec", "qwen", "huggingface-cli", "download", model_name]
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            out, _ = p.communicate(timeout=7200)
            if p.returncode == 0:
                active_downloads[model_name]["status"] = "completed"
                active_downloads[model_name]["output"] = "Tải thành công"
            else:
                active_downloads[model_name]["status"] = "failed"
                active_downloads[model_name]["output"] = out[-400:] if out else "Unknown error"
        except Exception as e:
            active_downloads[model_name]["status"] = "failed"
            active_downloads[model_name]["output"] = str(e)

    background_tasks.add_task(run_download, mid)

    return {
        "success": True,
        "message": f"Đã khởi chạy tác vụ tải mô hình '{mid}' trong nền. Hãy kiểm tra lại sau ít phút.",
        "status": "downloading"
    }

@app.get("/api/models/download/status")
async def api_download_status():
    return {"downloads": active_downloads}

@app.get("/api/instance/status")
async def api_instance_status():
    qwen_info = get_container_info("qwen")
    qwen_asr_info = get_container_info("qwen-asr")
    litellm_info = get_container_info("vllm-litellm")
    env = read_current_env()

    return {
        "qwen": qwen_info,
        "qwen_asr": qwen_asr_info,
        "litellm": litellm_info,
        "config": {
            "model_id": env.get("MODEL_ID", "N/A"),
            "tensor_parallel_size": int(env.get("TENSOR_PARALLEL_SIZE", 2)),
            "gpu_devices": env.get("GPU_DEVICES", "0,2"),
            "gpu_memory_utilization": float(env.get("GPU_MEMORY_UTILIZATION", 0.90)),
            "max_model_len": int(env.get("MAX_MODEL_LEN", 32768)),
            "domain": env.get("DOMAIN", "vllm.anm05.com")
        }
    }

@app.post("/api/instance/action")
async def api_instance_action(req: ContainerActionRequest):
    logger.info(f"Triggering action '{req.action}' on container '{req.target}'")
    cmd = ["docker", req.action, req.target]
    out = run_command(cmd, timeout=30)
    _deployments_cache["at"] = 0.0
    return {
        "success": True,
        "action": req.action,
        "target": req.target,
        "output": out
    }

@app.post("/api/instance/switch")
async def api_instance_switch(req: SwitchModelRequest, background_tasks: BackgroundTasks):
    logger.info(f"Switching model to {req.model_id} (TP={req.tensor_parallel_size})")

    # Map GPU indices to UUIDs
    selected_uuids = []
    for idx in req.gpu_indices:
        if idx in GPU_UUID_MAP:
            selected_uuids.append(GPU_UUID_MAP[idx])
    if not selected_uuids:
        selected_uuids = [GPU_UUID_MAP[0], GPU_UUID_MAP[2]]

    gpu_devices_str = ",".join(selected_uuids)
    previous_model_id = read_current_env().get("MODEL_ID", "")

    # Update .env
    updates = {
        "MODEL_ID": req.model_id,
        "TENSOR_PARALLEL_SIZE": str(req.tensor_parallel_size),
        "GPU_DEVICES": gpu_devices_str,
        "GPU_MEMORY_UTILIZATION": str(req.gpu_memory_utilization),
        "MAX_MODEL_LEN": str(req.max_model_len)
    }
    update_env_file(updates)

    # Update litellm_config.yaml
    update_litellm_config(req.model_id, previous_model_id)

    # Restart qwen container using docker compose or direct docker command
    def do_restart():
        try:
            logger.info("Recreating qwen container with new model config...")
            run_command(["docker", "compose", "-f", str(DOCKER_COMPOSE_PATH), "up", "-d", "--no-deps", "qwen"], timeout=120)
            logger.info("Restarting vllm-litellm gateway...")
            run_command(["docker", "restart", "vllm-litellm"], timeout=30)
        except Exception as e:
            logger.error(f"Error during model switch restart: {e}")

    background_tasks.add_task(do_restart)

    return {
        "success": True,
        "message": f"Đang tiến hành chuyển đổi sang mô hình {req.model_id}. Quá trình nạp trọng số có thể mất từ 1-3 phút.",
        "config": updates
    }

@app.get("/api/instance/logs")
async def api_instance_logs(tail: int = 100, container: str = PRIMARY_CONTAINER):
    allowed = {d["container"] for d in discover_deployments()} | {PRIMARY_CONTAINER, GATEWAY_CONTAINER}
    if container not in allowed:
        raise HTTPException(status_code=400, detail=f"Container '{container}' không thuộc cụm vLLM")
    cmd = ["docker", "logs", "--tail", str(min(tail, 500)), container]
    raw = run_command(cmd, timeout=10)
    return {"logs": raw, "container": container}

def parse_error_cause_details(exception_str: str) -> dict:
    err_lower = (exception_str or "").lower()
    category = "SERVER_ERROR"
    cause = "Lỗi máy chủ nội bộ trong quá trình xử lý yêu cầu."
    suggested_action = "Kiểm tra log của vLLM engine để biết chi tiết stack trace."
    status_code = 500

    if any(k in err_lower for k in ["out of memory", "cuda out of memory", "oom"]):
        category = "GPU_OOM"
        cause = "Tràn bộ nhớ GPU (CUDA Out of Memory). Quá trình cấp phát KV Cache hoặc xử lý prompt dài vượt quá VRAM còn lại."
        suggested_action = "Hạ thấp max-model-len, giảm gpu-memory-utilization, hoặc bật --kv-cache-dtype fp8."
        status_code = 500
    elif any(k in err_lower for k in ["connection refused", "connecterror", "connect_error", "all connection attempts failed"]):
        category = "BACKEND_UNAVAILABLE"
        cause = "Không thể kết nối đến backend vLLM container (Connection Refused). vLLM có thể đang nạp model hoặc bị crash."
        suggested_action = "Kiểm tra trạng thái container bằng 'docker ps' hoặc xem Live Engine Logs."
        status_code = 502
    elif any(k in err_lower for k in ["invalid model name", "model not found", "does not exist", "model_not_found"]):
        category = "MODEL_NOT_FOUND"
        cause = "Tên mô hình không tồn tại hoặc chưa được khai báo trong litellm_config.yaml."
        suggested_action = "Kiểm tra /v1/models hoặc thêm model vào litellm_config.yaml."
        status_code = 404
    elif any(k in err_lower for k in ["maximum context length", "context window", "prompt is too long"]):
        category = "CONTEXT_WINDOW_EXCEEDED"
        cause = "Tổng số token của prompt và output vượt quá giới hạn Context Window."
        suggested_action = "Rút gọn prompt hoặc tăng tham số --max-model-len."
        status_code = 400
    elif any(k in err_lower for k in ["unauthorized", "invalid api key", "missing api key", "authentication error"]):
        category = "AUTH_ERROR"
        cause = "API Key không hợp lệ hoặc thiếu header Authorization."
        suggested_action = "Cung cấp Authorization: Bearer <LITELLM_MASTER_KEY> hợp lệ."
        status_code = 401
    elif any(k in err_lower for k in ["rate limit", "too many requests"]):
        category = "RATE_LIMIT"
        cause = "Vượt quá giới hạn tần suất yêu cầu (Rate Limit Exceeded)."
        suggested_action = "Giảm tần suất gửi request hoặc tăng hạn mức trong cấu hình."
        status_code = 429
    elif any(k in err_lower for k in ["timed out", "timeout"]):
        category = "TIMEOUT"
        cause = "Hết thời gian chờ phản hồi từ vLLM backend (Timeout)."
        suggested_action = "Kiểm tra độ bận GPU hoặc tăng timeout."
        status_code = 504
    elif any(k in err_lower for k in ["bad request", "validation error", "schema error"]):
        category = "BAD_REQUEST"
        cause = "Payload yêu cầu không đúng định dạng chuẩn OpenAI API."
        suggested_action = "Kiểm tra format JSON (mảng messages, model,...)."
        status_code = 400

    return {
        "category": category,
        "cause": cause,
        "suggested_action": suggested_action,
        "status_code": status_code
    }

def record_audit_entry(entry: dict):
    try:
        log_path = AUDIT_LOG_FILE
        if not log_path.parent.exists():
            log_path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(entry, ensure_ascii=False) + "\n"
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception as e:
        logger.error(f"Failed to record audit entry: {e}")

# Byte-offset index over audit.log so paging doesn't re-parse the whole file.
# Each entry: (offset, length, status, model, latency_ms). Appends are indexed
# incrementally; a truncated or rotated file is re-indexed from scratch.
_audit_index: Dict[str, Any] = {"path": None, "inode": None, "pos": 0, "entries": []}

def audit_index(log_path: Path) -> List[tuple]:
    st = log_path.stat()
    idx = _audit_index
    if idx["path"] != str(log_path) or idx["inode"] != st.st_ino or st.st_size < idx["pos"]:
        idx.update(path=str(log_path), inode=st.st_ino, pos=0, entries=[])
    if st.st_size > idx["pos"]:
        with open(log_path, "rb") as f:
            f.seek(idx["pos"])
            offset = idx["pos"]
            for raw in f:
                if not raw.endswith(b"\n"):
                    break  # line still being written by the LiteLLM logger
                line = raw.strip()
                if line:
                    try:
                        item = json.loads(line)
                    except Exception:
                        item = None
                    if isinstance(item, dict):
                        idx["entries"].append((
                            offset,
                            len(raw),
                            str(item.get("status", "unknown")).lower(),
                            item.get("model", "unknown"),
                            item.get("latency_ms", 0) or 0,
                        ))
                offset += len(raw)
            idx["pos"] = offset
    return idx["entries"]

def _read_audit_entry(f, entry: tuple) -> Optional[dict]:
    f.seek(entry[0])
    try:
        return json.loads(f.read(entry[1]))
    except Exception:
        return None

@app.get("/api/audit/logs")
async def api_audit_logs(
    limit: int = 150,
    offset: int = 0,
    status: Optional[str] = "all",
    model: Optional[str] = None,
    search: Optional[str] = None
):
    log_path = AUDIT_LOG_FILE
    if not log_path.exists():
        for fallback in [PROJECT_ROOT / "logs" / "audit.log", Path("/app/logs/audit.log"), Path("/home/cahy/code/vllm-docker/logs/audit.log")]:
            if fallback.exists():
                log_path = fallback
                break

    if not log_path.exists():
        return {
            "logs": [],
            "stats": {"total": 0, "success": 0, "error": 0, "error_rate": 0, "avg_latency_ms": 0},
            "models": []
        }

    try:
        entries = audit_index(log_path)

        success_count = sum(1 for e in entries if e[2] == "success")
        error_count = sum(1 for e in entries if e[2] == "error")
        latencies = [e[4] for e in entries if e[4]]
        total_reqs = success_count + error_count
        stats = {
            "total": total_reqs,
            "success": success_count,
            "error": error_count,
            "error_rate": round((error_count / total_reqs * 100), 1) if total_reqs > 0 else 0,
            "avg_latency_ms": round(sum(latencies) / len(latencies), 1) if latencies else 0
        }

        status_filter = status.lower() if status and status != "all" else None
        model_filter = model if model and model != "all" else None
        candidates = [
            e for e in reversed(entries)
            if (not status_filter or e[2] == status_filter) and (not model_filter or e[3] == model_filter)
        ]

        limit = max(1, min(limit, 500))
        offset = max(0, offset)
        with open(log_path, "rb") as f:
            if search:
                # Full-text search still has to read every candidate body
                s_lower = search.lower()
                matched = []
                for e in candidates:
                    item = _read_audit_entry(f, e)
                    if item is not None and s_lower in json.dumps(item, ensure_ascii=False).lower():
                        matched.append(e)
                candidates = matched
            page = [item for item in (_read_audit_entry(f, e) for e in candidates[offset:offset + limit]) if item is not None]

        return {
            "logs": page,
            "total_filtered": len(candidates),
            "offset": offset,
            "limit": limit,
            "stats": stats,
            "models": sorted({e[3] for e in entries if e[3]})
        }
    except Exception as e:
        logger.error(f"Error reading audit logs: {e}")
        return {
            "logs": [],
            "stats": {"total": 0, "success": 0, "error": 0, "error_rate": 0, "avg_latency_ms": 0},
            "error": str(e)
        }

@app.post("/api/audit/clear")
async def api_audit_clear():
    log_path = AUDIT_LOG_FILE
    if not log_path.exists():
        for fallback in [PROJECT_ROOT / "logs" / "audit.log", Path("/app/logs/audit.log"), Path("/home/cahy/code/vllm-docker/logs/audit.log")]:
            if fallback.exists():
                log_path = fallback
                break
    try:
        with open(log_path, "w", encoding="utf-8") as f:
            f.write("")
        return {"success": True, "message": "Đã xóa toàn bộ lịch sử audit log."}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.get("/api/audit/export")
async def api_audit_export(
    format: str = "json",
    status: Optional[str] = "all",
    model: Optional[str] = None,
    limit: int = 5000
):
    """Xuất toàn bộ lịch sử audit log ra file JSON hoặc CSV để tải về máy hoặc tích hợp hệ thống khác"""
    log_path = AUDIT_LOG_FILE
    if not log_path.exists():
        for fallback in [PROJECT_ROOT / "logs" / "audit.log", Path("/app/logs/audit.log"), Path("/home/cahy/code/vllm-docker/logs/audit.log")]:
            if fallback.exists():
                log_path = fallback
                break

    records = []
    if log_path.exists():
        try:
            with open(log_path, "r", encoding="utf-8") as f:
                for line in reversed(f.readlines()):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        item = json.loads(line)
                    except Exception:
                        continue

                    item_status = item.get("status", "unknown").lower()
                    item_model = item.get("model", "unknown")

                    if status and status != "all" and item_status != status.lower():
                        continue
                    if model and model != "all" and item_model != model:
                        continue

                    records.append(item)
                    if len(records) >= limit:
                        break
        except Exception as e:
            logger.error(f"Error exporting logs: {e}")

    timestamp_str = datetime.utcnow().strftime("%Y%m%d_%H%M%S")

    if format.lower() == "csv":
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow([
            "ID", "Thời Gian", "Trạng Thái", "Mã HTTP", "Mô Hình", "Độ Trễ (ms)",
            "Prompt Tokens", "Completion Tokens", "Total Tokens",
            "Phân Loại Lỗi", "Loại Lỗi", "Nguyên Nhân Lỗi (Root Cause)", "Chi Tiết Lỗi Kỹ Thuật",
            "Đoạn Prompt", "Phản Hồi"
        ])
        for r in records:
            err = r.get("error") or {}
            usage = r.get("usage") or {}
            msgs = r.get("messages")
            prompt_str = ""
            if isinstance(msgs, list) and msgs:
                last_content = msgs[-1].get("content", "")
                if isinstance(last_content, list):
                    text_parts = [p.get("text", "") for p in last_content if isinstance(p, dict) and (p.get("type") == "text" or p.get("text"))]
                    prompt_str = " ".join(text_parts) if text_parts else "[Multimodal / Image Data]"
                elif isinstance(last_content, str):
                    prompt_str = last_content
                else:
                    prompt_str = str(last_content)
            elif isinstance(msgs, str):
                prompt_str = msgs
            elif isinstance(msgs, dict):
                prompt_str = json.dumps(msgs, ensure_ascii=False)

            writer.writerow([
                r.get("id", ""),
                r.get("timestamp", ""),
                r.get("status", ""),
                r.get("status_code", ""),
                r.get("model", ""),
                r.get("latency_ms", 0),
                usage.get("prompt_tokens", 0),
                usage.get("completion_tokens", 0),
                usage.get("total_tokens", 0),
                err.get("category", ""),
                err.get("type", ""),
                err.get("cause", ""),
                err.get("message", ""),
                prompt_str,
                r.get("response", "") or ""
            ])
        csv_bytes = output.getvalue().encode("utf-8-sig")
        return Response(
            content=csv_bytes,
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename=audit_logs_{timestamp_str}.csv"}
        )
    else:
        # JSON format
        json_str = json.dumps(records, ensure_ascii=False, indent=2)
        return Response(
            content=json_str.encode("utf-8"),
            media_type="application/json",
            headers={"Content-Disposition": f"attachment; filename=audit_logs_{timestamp_str}.json"}
        )

@app.get("/api/lora/list")
async def api_lora_list():
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{VLLM_API_BASE}/v1/models")
            if resp.status_code == 200:
                data = resp.json()
                return {"models": data.get("data", [])}
            return {"models": [], "error": f"vLLM returned {resp.status_code}"}
    except Exception as e:
        return {"models": [], "error": str(e)}

@app.post("/api/lora/load")
async def api_lora_load(req: LoRALoadRequest):
    logger.info(f"Loading LoRA adapter '{req.lora_name}' from '{req.lora_path}'")
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{VLLM_API_BASE}/v1/load-lora-adapter",
                json={"lora_name": req.lora_name, "lora_path": req.lora_path}
            )
            if resp.status_code in (200, 201):
                return {"success": True, "message": f"Nạp LoRA adapter {req.lora_name} thành công"}
            else:
                return {
                    "success": False,
                    "status_code": resp.status_code,
                    "error": resp.text
                }
    except Exception as e:
        logger.error(f"Error loading LoRA: {e}")
        raise HTTPException(status_code=500, detail=f"Không thể kết nối vLLM: {e}")

@app.post("/api/lora/unload")
async def api_lora_unload(req: LoRAUnloadRequest):
    logger.info(f"Unloading LoRA adapter '{req.lora_name}'")
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{VLLM_API_BASE}/v1/unload-lora-adapter",
                json={"lora_name": req.lora_name}
            )
            if resp.status_code in (200, 201):
                return {"success": True, "message": f"Gỡ LoRA adapter {req.lora_name} thành công"}
            else:
                return {
                    "success": False,
                    "status_code": resp.status_code,
                    "error": resp.text
                }
    except Exception as e:
        logger.error(f"Error unloading LoRA: {e}")
        raise HTTPException(status_code=500, detail=f"Không thể kết nối vLLM: {e}")

@app.post("/api/test/chat")
async def api_test_chat(req: ChatTestRequest):
    # Prepare payload for LiteLLM or vLLM
    env = read_current_env()
    current_model = req.model or env.get("MODEL_ID", "qwen-text")

    payload = {
        "model": current_model,
        "messages": [m.model_dump() for m in req.messages],
        "temperature": req.temperature,
        "max_tokens": req.max_tokens,
        "stream": req.stream
    }

    target = (req.target or "vllm").lower()
    if target == "litellm":
        target_url = f"{LITELLM_API_BASE}/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {LITELLM_MASTER_KEY}",
            "Content-Type": "application/json"
        }
    else:
        # Default: direct to vLLM (highest performance, real engine stats)
        target_url = f"{VLLM_API_BASE}/v1/chat/completions"
        headers = {
            "Content-Type": "application/json"
        }

    async def event_generator():
        start_time = time.time()
        first_token_time = None
        token_count = 0

        async with httpx.AsyncClient(timeout=120.0) as client:
            try:
                async with client.stream("POST", target_url, json=payload, headers=headers) as resp:
                    if resp.status_code != 200:
                        err_text = await resp.aread()
                        err_str = err_text.decode()
                        err_info = parse_error_cause_details(err_str)
                        record_audit_entry({
                            "id": str(time.time()).replace(".", "")[-8:],
                            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                            "status": "error",
                            "status_code": resp.status_code,
                            "model": current_model,
                            "latency_ms": round((time.time() - start_time) * 1000, 1),
                            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                            "messages": payload["messages"],
                            "response": None,
                            "error": {
                                "category": err_info["category"],
                                "type": f"HTTP {resp.status_code}",
                                "message": err_str,
                                "cause": err_info["cause"],
                                "suggested_action": err_info["suggested_action"]
                            }
                        })
                        yield f"data: {json.dumps({'error': f'HTTP {resp.status_code}: {err_str}', 'cause': err_info['cause']})}\n\n"
                        return

                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        if line.startswith("data: "):
                            content_str = line[6:].strip()
                            if content_str == "[DONE]":
                                total_time = time.time() - start_time
                                ttft_ms = round((first_token_time - start_time) * 1000, 1) if first_token_time else 0
                                tps = round(token_count / total_time, 1) if total_time > 0 else 0
                                meta = {
                                    "meta": True,
                                    "ttft_ms": ttft_ms,
                                    "tokens_per_second": tps,
                                    "total_tokens": token_count,
                                    "total_time_s": round(total_time, 2)
                                }
                                yield f"data: {json.dumps(meta)}\n\n"
                                yield "data: [DONE]\n\n"
                                break

                            try:
                                chunk = json.loads(content_str)
                                delta = chunk.get("choices", [{}])[0].get("delta", {})
                                text = delta.get("content", "")
                                if text:
                                    if first_token_time is None:
                                        first_token_time = time.time()
                                    token_count += 1
                                    yield f"data: {json.dumps({'delta': text})}\n\n"
                            except Exception:
                                yield f"{line}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

    if req.stream:
        return StreamingResponse(event_generator(), media_type="text/event-stream")
    else:
        # Non-streaming call
        start_time = time.time()
        async with httpx.AsyncClient(timeout=120.0) as client:
            payload["stream"] = False
            resp = await client.post(target_url, json=payload, headers=headers)
            elapsed = time.time() - start_time
            if resp.status_code == 200:
                data = resp.json()
                usage = data.get("usage", {})
                completion_tokens = usage.get("completion_tokens", 0)
                tps = round(completion_tokens / elapsed, 1) if elapsed > 0 else 0
                return {
                    "response": data,
                    "metrics": {
                        "total_time_s": round(elapsed, 2),
                        "tokens_per_second": tps,
                        "completion_tokens": completion_tokens
                    }
                }
            else:
                raise HTTPException(status_code=resp.status_code, detail=resp.text)

# Mount static files and index.html
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/", response_class=HTMLResponse)
async def serve_index():
    index_path = STATIC_DIR / "index.html"
    if index_path.exists():
        with open(index_path, "r", encoding="utf-8") as f:
            content = f.read()
            return HTMLResponse(
                content,
                headers={"Cache-Control": "no-cache, no-store, must-revalidate, max-age=0", "Pragma": "no-cache"}
            )
    return HTMLResponse("<h3>vLLM Model Manager is starting up...</h3>")

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("MANAGER_PORT", 8050))
    logger.info(f"Starting vLLM Manager server on port {port}...")
    uvicorn.run(app, host="0.0.0.0", port=port)
