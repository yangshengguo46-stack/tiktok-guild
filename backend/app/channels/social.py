"""Host-only social connection values. No production social provider is installed."""

from __future__ import annotations

from dataclasses import dataclass, field
from types import MappingProxyType

from deerflow.persistence.social import SocialRepository
from deerflow.social.contracts import IdentityProfile, RoleProfile, SocialScope, bounded_text

SOCIAL_CAPABILITY_MATRIX = MappingProxyType({"tiktok": MappingProxyType({"inbound": "unverified", "outbound": "unverified", "receipts": "unverified"})})
_ENVELOPE_AUTHORITY = object()


@dataclass(frozen=True)
class SocialCapabilities:
    inbound: bool = False
    outbound: bool = False
    receipts: bool = False

    def __post_init__(self):
        if any(type(value) is not bool for value in (self.inbound, self.outbound, self.receipts)):
            raise ValueError("capabilities must be host-owned booleans")


@dataclass(frozen=True)
class AuthenticatedSocialEvent:
    """A provider-authenticated event, never constructed from free-form metadata.

    The adapter must verify provider signature/session and creator authorship
    before returning this value from authenticate_social_event.
    """

    event_id: str
    text: str
    external_account_id: str
    workspace_id: str
    chat_id: str
    source_kind: str

    def __post_init__(self):
        for name in ("event_id", "external_account_id", "workspace_id", "chat_id"):
            bounded_text(getattr(self, name), name, 128)
        bounded_text(self.text, "text", 16384)
        if self.source_kind not in {"creator_message", "operator_note", "platform_observation"}:
            raise ValueError("invalid social source kind")


@dataclass(frozen=True)
class SocialConnection:
    """Operator-provisioned connection resolution, supplied by host code only.

    thread_id is an existing native Gateway thread. These values are not
    read from channel session config, remote messages, or provider text.
    """

    repository: SocialRepository
    scope: SocialScope
    identity: IdentityProfile
    role: RoleProfile
    thread_id: str
    provider: str
    external_account_id: str
    workspace_id: str
    chat_id: str
    channel_safe_tool_names: frozenset[str] = frozenset()
    identity_verified: bool = False

    def __post_init__(self):
        if not isinstance(self.repository, SocialRepository) or not isinstance(self.scope, SocialScope) or not isinstance(self.identity, IdentityProfile) or not isinstance(self.role, RoleProfile):
            raise ValueError("social connections require canonical host-owned values")
        if type(self.identity_verified) is not bool:
            raise ValueError("person identity verification must be a host-owned boolean")
        for name in ("thread_id", "provider", "external_account_id", "workspace_id", "chat_id"):
            bounded_text(getattr(self, name), name, 128)
        if not isinstance(self.channel_safe_tool_names, frozenset) or any(not isinstance(name, str) or not name for name in self.channel_safe_tool_names):
            raise ValueError("channel-safe tools must be a host-owned frozenset")


@dataclass(frozen=True)
class SocialInboundEnvelope:
    scope: SocialScope
    source_event_id: str
    source_kind: str
    identity_verified: bool
    provider_receipt_capability: str
    _authority: object = field(repr=False, compare=False)

    def __post_init__(self):
        if self._authority is not _ENVELOPE_AUTHORITY:
            raise ValueError("only authenticated ChannelManager resolution may mint envelopes")


@dataclass(frozen=True)
class SocialProviderResult:
    """Actual provider acknowledgement; delivered requires a receipt reference.

    rejected means a definitive provider refusal. Exceptions/timeouts, None,
    malformed responses and unsupported acknowledgement levels stay unknown.
    """

    state: str
    provider_ref: str | None
    evidence_ref: str | None
    receipt_ref: str | None = None

    def __post_init__(self):
        if self.state not in {"accepted", "delivered", "rejected", "unknown"}:
            raise ValueError("invalid provider acknowledgement")
        for name in ("provider_ref", "evidence_ref", "receipt_ref"):
            value = getattr(self, name)
            if value is not None:
                bounded_text(value, name, 128)


@dataclass(frozen=True)
class AuthenticatedSocialReceipt:
    receipt_id: str
    action_id: str
    external_account_id: str
    workspace_id: str
    chat_id: str
    result: SocialProviderResult

    def __post_init__(self):
        for name in ("receipt_id", "action_id", "external_account_id", "workspace_id", "chat_id"):
            bounded_text(getattr(self, name), name, 128)
        if not isinstance(self.result, SocialProviderResult) or self.result.evidence_ref != self.receipt_id:
            raise ValueError("authenticated receipt must carry its provider evidence reference")
        if self.result.state == "delivered" and self.result.receipt_ref != self.receipt_id:
            raise ValueError("delivery requires the authenticated provider receipt")
