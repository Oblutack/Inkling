FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Tesseract reads scanned pages (see ocr.py), with the Latin-script languages OCR_LANGUAGES names. Each language is a few megabytes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng tesseract-ocr-deu tesseract-ocr-fra \
       tesseract-ocr-spa tesseract-ocr-ita tesseract-ocr-por tesseract-ocr-hrv \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt

# The embedding model is downloaded now, so the service never needs the internet to start. The folder is
# writable by the app user, so a different EMBEDDING_MODEL can still be fetched at run time.
ARG EMBEDDING_MODEL=BAAI/bge-small-en-v1.5
ENV FASTEMBED_CACHE_PATH=/opt/models
RUN mkdir -p /opt/models && python -c "from fastembed import TextEmbedding; TextEmbedding(model_name='${EMBEDDING_MODEL}')"

COPY . .

# Run as an unprivileged user.
RUN useradd --create-home --uid 10001 appuser && chown -R appuser /opt/models
USER appuser

# Hosts like Render set PORT; default to 10000.
EXPOSE 10000

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
    CMD ["python", "-c", "import os,sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.getenv('PORT', '10000'), timeout=3).status == 200 else 1)"]

CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-10000} --no-access-log"]
