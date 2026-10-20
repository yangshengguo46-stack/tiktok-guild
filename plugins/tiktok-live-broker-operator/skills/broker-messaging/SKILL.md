---
name: broker-messaging
description: Use the isolated broker Backstage profile to message a creator by exact creator_id from TKDesk.
---

# Broker messaging

Use `broker_workspace` to bind the broker profile first. Copy the exact `userId` from a TKDesk candidate and pass it as `creator_id` to `broker_messaging.prepare_message`; then call `broker_messaging.send_message` with the same workflow ID. Keep the sender account reference fixed to the configured broker profile. Treat missing profile, identity mismatch, provider rejection, or missing read-back as an incomplete operation.
