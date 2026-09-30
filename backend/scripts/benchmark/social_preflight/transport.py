"""One real model call in a killable subprocess; no model retries or MCP loading."""

import asyncio
import json
import sys


async def main():
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

    from deerflow.config.app_config import AppConfig
    from deerflow.models import create_chat_model

    payload = json.loads(sys.stdin.read())
    if payload.get("live") is not True:
        raise ValueError("explicit live transport required")
    config = AppConfig.from_file(payload["config"])
    model = create_chat_model(name=payload["model"], app_config=config, thinking_enabled=False, attach_tracing=False, disable_streaming=True)
    fields = type(model).model_fields
    if "retry_max_attempts" in fields:
        model.retry_max_attempts = 1
    elif "max_retries" in fields:
        # Rebuild clients with the retry setting; changing a field after client
        # construction is insufficient for SDK-backed providers.
        selected = config.get_model_config(payload["model"])
        selected.__pydantic_extra__["max_retries"] = 0
        model = create_chat_model(name=payload["model"], app_config=config, thinking_enabled=False, attach_tracing=False, disable_streaming=True)
    else:
        raise ValueError("provider retry behavior is not controlled by this preflight")
    kinds = {"system": SystemMessage, "human": HumanMessage, "ai": AIMessage}
    messages = [kinds[item["type"]](content=item["content"]) for item in payload["messages"]]
    response = await model.ainvoke(messages, stream=False)
    if response.tool_calls or response.invalid_tool_calls:
        raise ValueError("preflight model requested a forbidden tool")
    print(json.dumps({"content": response.content, "usage": response.usage_metadata, "model": config.get_model_config(payload["model"]).model}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        # Do not copy provider errors, credentials, URLs or arbitrary bodies.
        print(json.dumps({"error": type(error).__name__}))
        raise SystemExit(1) from None
