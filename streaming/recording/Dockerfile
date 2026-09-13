FROM bluenviron/mediamtx:1.20.0 AS mediamtx
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY --from=mediamtx /mediamtx /usr/local/bin/mediamtx
COPY *.py schema.sql mediamtx.yml ./
RUN useradd -u 10001 --create-home recorder
USER 10001
ENV PYTHONUNBUFFERED=1 TZ=UTC
CMD ["python", "worker.py"]
