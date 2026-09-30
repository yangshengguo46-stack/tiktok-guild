from __future__ import annotations

import asyncio

import pytest

from app.channels.message_bus import (
    ChannelDeliveryReceipt,
    ChannelDeliveryState,
    ChannelEnvelope,
    InboundMessage,
    MessageBus,
    OutboundMessage,
)


def test_inbound_message_exposes_a_source_backed_envelope_and_route():
    message = InboundMessage(
        channel_name="tiktok",
        chat_id="conversation-1",
        user_id="creator-1",
        text="hello",
        connection_id="connection-1",
        owner_user_id="owner-1",
        workspace_id="guild-1",
        message_id="provider-message-1",
        source_ref="tiktok:event:1",
    )

    envelope = message.to_envelope()

    assert isinstance(envelope, ChannelEnvelope)
    assert envelope.direction == "inbound"
    assert envelope.message_id == "provider-message-1"
    assert envelope.source_ref == "tiktok:event:1"
    assert envelope.identity.external_user_id == "creator-1"
    assert envelope.identity.owner_user_id == "owner-1"
    assert envelope.route.connection_id == "connection-1"
    assert envelope.route.chat_id == "conversation-1"
    assert envelope.identity.status == "bound"


def test_outbound_envelope_keeps_reply_route_and_starts_pending():
    message = OutboundMessage(
        channel_name="tiktok",
        chat_id="conversation-1",
        thread_id="thread-1",
        text="reply",
        connection_id="connection-1",
        owner_user_id="owner-1",
        action_id="action-1",
        in_reply_to="provider-message-1",
    )

    envelope = message.to_envelope()

    assert envelope.direction == "outbound"
    assert envelope.route.thread_id == "thread-1"
    assert envelope.route.connection_id == "connection-1"
    assert envelope.in_reply_to == "provider-message-1"
    assert message.delivery_state == ChannelDeliveryState.PENDING


@pytest.mark.asyncio
async def test_bus_marks_missing_provider_receipt_unknown_and_accepts_typed_receipt():
    bus = MessageBus()
    ordinary = OutboundMessage(channel_name="telegram", chat_id="chat", thread_id="thread", text="hello")
    tiktok = OutboundMessage(channel_name="tiktok", chat_id="chat", thread_id="thread", text="hello")

    async def ordinary_callback(message):
        assert message is ordinary

    async def tiktok_callback(message):
        assert message is tiktok
        return ChannelDeliveryReceipt(state=ChannelDeliveryState.DELIVERED, provider_ref="p-1", receipt_ref="r-1")

    bus.subscribe_outbound(ordinary_callback)
    await bus.publish_outbound(ordinary)
    assert ordinary.delivery_state == ChannelDeliveryState.UNKNOWN
    assert ordinary.receipt_ref is None

    bus.unsubscribe_outbound(ordinary_callback)
    bus.subscribe_outbound(tiktok_callback)
    await bus.publish_outbound(tiktok)
    assert tiktok.delivery_state == ChannelDeliveryState.DELIVERED
    assert tiktok.provider_ref == "p-1"
    assert tiktok.receipt_ref == "r-1"


@pytest.mark.asyncio
async def test_unverified_tiktok_without_receipt_requires_manual_reconciliation():
    bus = MessageBus()
    message = OutboundMessage(channel_name="tiktok", chat_id="chat", thread_id="thread", text="hello")

    async def callback(_message):
        return None

    bus.subscribe_outbound(callback)
    await bus.publish_outbound(message)
    assert message.delivery_state == ChannelDeliveryState.MANUAL_REQUIRED


def test_inbound_dedupe_identity_prefers_explicit_message_id():
    from app.channels.manager import ChannelManager

    message = InboundMessage(
        channel_name="telegram",
        chat_id="chat",
        user_id="user",
        text="hello",
        workspace_id="workspace",
        message_id="explicit-id",
        metadata={"message_id": "untrusted-metadata-id"},
    )

    assert ChannelManager._inbound_dedupe_key(message) == ("telegram", "workspace", "chat", "explicit-id")


def test_unified_channel_status_marks_tiktok_manual_required():
    from app.gateway.routers.channels import get_unified_channel_status

    result = asyncio.run(get_unified_channel_status())
    tiktok = result.providers["tiktok"]
    assert tiktok["inbound"] == "unverified"
    assert tiktok["outbound"] == "unverified"
    assert tiktok["receipts"] == "unverified"
    assert tiktok["write_state"] == "manual_required"
