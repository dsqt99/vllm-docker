FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install static docker CLI so container can manage docker-compose & containers
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.1.1.tgz | tar -xz -C /usr/local/bin --strip-components=1 docker/docker

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8050

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8050/api/health || exit 1

CMD ["python", "main.py"]
