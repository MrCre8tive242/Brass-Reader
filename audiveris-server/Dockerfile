FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip curl ca-certificates jq tesseract-ocr tesseract-ocr-eng \
      libfreetype6 fontconfig && rm -rf /var/lib/apt/lists/*
# Latest Audiveris Linux .deb (bundles its own JRE). Prefer the ubuntu24.04 asset, else any ubuntu .deb.
RUN set -eux; \
    curl -fsSL https://api.github.com/repos/Audiveris/audiveris/releases/latest -o /tmp/rel.json; \
    URL=$(jq -r '[.assets[].browser_download_url | select(endswith(".deb")) | select(test("x86_64|amd64"))] | (map(select(test("ubuntu24"))) + map(select(test("ubuntu"))) + .)[0]' /tmp/rel.json); \
    echo "Installing $URL"; curl -fsSL "$URL" -o /tmp/audiveris.deb; \
    apt-get update; apt-get install -y /tmp/audiveris.deb; rm -rf /tmp/*.deb /var/lib/apt/lists/*
ENV TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata
ENV AUDIVERIS_CMD=/opt/audiveris/bin/Audiveris
WORKDIR /app
COPY requirements.txt .
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt
COPY server.py .
ENV PORT=8080
EXPOSE 8080
# one worker: Audiveris is memory hungry; threads allow /health during a run
CMD gunicorn -w 1 --threads 4 -t 300 -b 0.0.0.0:${PORT} server:app
