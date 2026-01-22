FROM python:3.11-slim

# Install dependencies
# CVE-2026-24049: Path Traversal vulnerability in wheel <= 0.46.1
RUN pip install --upgrade wheel>=0.46.2 && pip install mcp pydantic

# Copy the MCP server
COPY main.py /app/main.py
WORKDIR /app

# Make the script executable
RUN chmod +x main.py

# Run the MCP server
CMD ["python", "main.py"]