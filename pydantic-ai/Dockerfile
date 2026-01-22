FROM python:3.11.3

WORKDIR /app

# Copy requirements and install dependencies
COPY requirements.txt .
# CVE-2026-24049: Path Traversal vulnerability in wheel <= 0.46.1
RUN pip install --upgrade wheel>=0.46.2
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY main.py .
COPY .env .

# Set entrypoint to run the agent
ENTRYPOINT ["python", "main.py"]
