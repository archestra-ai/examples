"""
Archestra LLM Proxy — OpenAI Python SDK example.

Routes OpenAI requests through the Archestra platform for security
guardrails, observability, and policy enforcement.

Usage:
    cp .env.example .env   # fill in OPENAI_API_KEY and ARCHESTRA_PROXY_URL
    pip install -r requirements.txt
    python main.py
"""

import os
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

api_key = os.environ["OPENAI_API_KEY"]
proxy_url = os.environ.get("ARCHESTRA_PROXY_URL", "http://localhost:9000/v1/openai")

# Point the OpenAI client at the Archestra proxy instead of api.openai.com.
# All other SDK usage stays identical — Archestra is transparent to the caller.
client = OpenAI(
    api_key=api_key,
    base_url=proxy_url,
)


def chat(user_message: str, history: list[dict]) -> str:
    """Send a message and return the assistant reply."""
    history.append({"role": "user", "content": user_message})

    response = client.chat.completions.create(
        model="gpt-4o",
        messages=history,
    )

    reply = response.choices[0].message.content
    history.append({"role": "assistant", "content": reply})
    return reply


def main() -> None:
    print("Archestra + OpenAI Python chat (type 'quit' to exit)\n")
    history: list[dict] = []

    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nGoodbye!")
            break

        if user_input.lower() in {"quit", "exit", "q"}:
            print("Goodbye!")
            break

        if not user_input:
            continue

        reply = chat(user_input, history)
        print(f"Assistant: {reply}\n")


if __name__ == "__main__":
    main()
