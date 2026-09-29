"""Gateway-installed trusted credentials for the owner-scoped outreach MCP.

The harness never imports app. Credentials are injected after runtime user
resolution, never loaded from tool arguments or a globally configured owner.
"""

from collections.abc import Callable

_provider: Callable[[str], dict[str, str]] | None = None


def set_public_outreach_auth_provider(provider: Callable[[str], dict[str, str]] | None) -> None:
    global _provider
    _provider = provider


def public_outreach_session_env(owner_user_id: str) -> dict[str, str]:
    return _provider(owner_user_id) if _provider is not None else {}
