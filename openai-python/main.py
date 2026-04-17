"""
Archestra LLM Proxy — OpenAI Python SDK example.

Routes OpenAI requests through the Archestra platform for security
guardrails, observability, and policy enforcement.

Usage:
    cp .env.example .env   # fill in OPENAI_API_KEY and ARCHESTRA_PROXY_URL
    pip install -r requirements.txt
    python main.py             # streaming (default)
    python main.py --no-stream # non-streaming
"""

import os
import sys
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


def chat_stream(user_message: str, history: list[dict]) -> str:
    """Send a message and stream the assistant reply token by token."""
    history.append({"role": "user", "content": user_message})

    full_reply = ""
    with client.chat.completions.create(
        model="gpt-4o",
        messages=history,
        stream=True,
    ) as stream:
        for chunk in stream:
            delta = chunk.choices[0].delta.content or ""
            print(delta, end="", flush=True)
            full_reply += delta
    print()  # newline after streaming finishes

    history.append({"role": "assistant", "content": full_reply})
    return full_reply


def chat(user_message: str, history: list[dict]) -> str:
    """Send a message and return the complete assistant reply."""
    history.append({"role": "user", "content": user_message})

    response = client.chat.completions.create(
        model="gpt-4o",
        messages=history,
    )

    reply = response.choices[0].message.content
    history.append({"role": "assistant", "content": reply})
    return reply


def main() -> None:
    use_stream = "--no-stream" not in sys.argv

    mode = "streaming" if use_stream else "non-streaming"
    print(f"Archestra + OpenAI Python chat [{mode}] (type 'quit' to exit)\n")
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

        if use_stream:
            print("Assistant: ", end="")
            chat_stream(user_input, history)
        else:
            reply = chat(user_input, history)
            print(f"Assistant: {reply}\n")


if __name__ == "__main__":
    main()
