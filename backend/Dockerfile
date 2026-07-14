# Vessel Caller API — production image
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

# deps first for layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# run as non-root
RUN useradd --create-home --uid 10001 appuser && chown -R appuser /srv
USER appuser

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health').status==200 else 1)"

# For SQLite persistence, mount a volume and point VC_DATABASE_URL at it, e.g.
#   -v vessel-data:/data -e VC_DATABASE_URL=sqlite:////data/vessel_caller.db
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
