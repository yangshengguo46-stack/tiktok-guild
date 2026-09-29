import { expect, test } from "@playwright/test";

test("renders the mocked public outreach workbench and receipt evidence", async ({
  page,
}) => {
  await page.route("**/api/public-outreach/accounts", (route) =>
    route.fulfill({
      json: {
        accounts: [
          {
            sender_account_id: "web:ordinary-001",
            channel: "web",
            status: "healthy",
            health: "healthy",
            capabilities: { like: true, comment: true, follow: true },
          },
          {
            sender_account_id: "ios:device-001:ordinary-002",
            channel: "ios",
            status: "ready",
            health: "ready",
            device_ref: "device-001",
            capabilities: { like: true, comment: true, follow: true },
          },
        ],
        web_batch_capacity: {
          registered: 1,
          maximum: 50,
          active_limit: 10,
          active: 1,
        },
        ios_readiness: { registered: 1, ready: 1 },
        operator: { configured: true },
      },
    }),
  );
  await page.route("**/api/public-outreach/tasks?*", (route) =>
    route.fulfill({
      json: {
        tasks: [
          {
            task_id: "task-like-001",
            creator_uid: "creator-001",
            sequence_no: 1,
            sender_account_id: "web:ordinary-001",
            action: "like",
            current_action: "like",
            state: "completed",
            receipt_state: "verified",
            attempt_count: 1,
          },
        ],
      },
    }),
  );
  await page.route("**/api/public-outreach/tasks/task-like-001", (route) =>
    route.fulfill({
      json: {
        task_id: "task-like-001",
        creator_uid: "creator-001",
        sequence_no: 1,
        sender_account_id: "web:ordinary-001",
        action: "like",
        current_action: "like",
        state: "completed",
        receipt_state: "verified",
        attempt_count: 1,
        receipts: [
          {
            receipt_id: "receipt-like-001",
            kind: "public_action_receipt",
            verified: true,
            verification_source: "provider_readback",
          },
        ],
      },
    }),
  );

  await page.goto("/workspace/guild");

  await expect(
    page.getByRole("heading", { name: "Creator outreach workbench" }),
  ).toBeVisible();
  await expect(page.getByText("web:ordinary-001")).toBeVisible();
  await expect(page.getByText("iPhone accounts")).toBeVisible();

  await page.getByLabel("Creator UID").fill("creator-001");
  await page.getByRole("button", { name: "Load tasks" }).click();
  await expect(page.getByTestId("outreach-task-task-like-001")).toBeVisible();
  await page.getByTestId("outreach-task-task-like-001").click();

  await expect(page.getByText("public_action_receipt")).toBeVisible();
  await expect(page.getByText("provider_readback")).toBeVisible();
});
