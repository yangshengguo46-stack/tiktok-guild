from unittest.mock import AsyncMock, patch

import pytest
from langchain_core.tools import StructuredTool
from pydantic import BaseModel

from deerflow.config.extensions_config import ExtensionsConfig
from deerflow.mcp.tools import get_mcp_tools


class _Args(BaseModel):
    pass


def _tool(name: str) -> StructuredTool:
    async def _call() -> str:
        return name

    return StructuredTool(name=name, description=name, args_schema=_Args, coroutine=_call)


async def _load_tools(*, prefix: bool, enabled_tools: list[str], discovered: list[str], required: bool = True):
    server_name = "approved"
    extensions = ExtensionsConfig.model_validate(
        {
            "mcpServers": {
                server_name: {
                    "type": "stdio",
                    "command": "node",
                    "tool_name_prefix": prefix,
                    "required": required,
                    "enabled_tools": enabled_tools,
                }
            }
        }
    )
    connection = {"transport": "stdio", "command": "node", "args": []}

    class FakeClient:
        def __init__(self, connections, **kwargs):
            self.callbacks = None
            self.tool_interceptors = []

        async def get_tools(self, *, server_name=None):
            assert prefix is True
            return [_tool(f"{server_name}_{name}") for name in discovered]

    async def fake_load_mcp_tools(*args, **kwargs):
        assert prefix is False
        return [_tool(name) for name in discovered]

    with (
        patch("deerflow.mcp.tools.ExtensionsConfig.from_file", return_value=extensions),
        patch("deerflow.mcp.tools.build_servers_config", return_value={server_name: connection}),
        patch("deerflow.mcp.tools.get_initial_oauth_headers", new_callable=AsyncMock, return_value={}),
        patch("deerflow.mcp.tools.build_mcp_tool_interceptors", return_value=[]),
        patch("langchain_mcp_adapters.client.MultiServerMCPClient", FakeClient),
        patch("langchain_mcp_adapters.tools.load_mcp_tools", side_effect=fake_load_mcp_tools),
        patch("deerflow.mcp.tools._make_session_pool_tool", side_effect=lambda tool, *_args, **_kwargs: tool),
    ):
        return await get_mcp_tools()


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", [True, False])
async def test_enabled_tools_filters_extras_and_preserves_approved_order(prefix: bool) -> None:
    tools = await _load_tools(
        prefix=prefix,
        enabled_tools=["beta", "alpha"],
        discovered=["alpha", "send_message", "beta"],
    )

    assert [tool.name for tool in tools] == (["approved_beta", "approved_alpha"] if prefix else ["beta", "alpha"])


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", [True, False])
async def test_required_server_fails_closed_when_an_approved_tool_is_missing(prefix: bool) -> None:
    with pytest.raises(RuntimeError, match="(?i)required.*missing|missing.*required"):
        await _load_tools(
            prefix=prefix,
            enabled_tools=["alpha", "missing"],
            discovered=["alpha", "extra"],
        )


@pytest.mark.asyncio
async def test_required_server_discovery_failure_is_not_silently_skipped() -> None:
    extensions = ExtensionsConfig.model_validate(
        {
            "mcpServers": {
                "required_server": {
                    "type": "stdio",
                    "command": "node",
                    "required": True,
                    "enabled_tools": ["inspect"],
                }
            }
        }
    )

    class BrokenClient:
        def __init__(self, connections, **kwargs):
            self.callbacks = None
            self.tool_interceptors = []

        async def get_tools(self, *, server_name=None):
            raise OSError("discovery unavailable")

    with (
        patch("deerflow.mcp.tools.ExtensionsConfig.from_file", return_value=extensions),
        patch("deerflow.mcp.tools.build_servers_config", return_value={"required_server": {"transport": "stdio", "command": "node", "args": []}}),
        patch("deerflow.mcp.tools.get_initial_oauth_headers", new_callable=AsyncMock, return_value={}),
        patch("deerflow.mcp.tools.build_mcp_tool_interceptors", return_value=[]),
        patch("langchain_mcp_adapters.client.MultiServerMCPClient", BrokenClient),
    ):
        with pytest.raises(RuntimeError, match="required_server.*discovery"):
            await get_mcp_tools()
