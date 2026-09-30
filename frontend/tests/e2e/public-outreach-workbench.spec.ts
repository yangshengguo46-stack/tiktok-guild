import { expect, test } from "@playwright/test";

test("renders the mocked public outreach workbench and receipt evidence", async ({
  page,
}) => {
  await page.route("**/api/public-outreach/accounts", (route) =>
    route.fulfill({
      json: {
        accounts: [
          {
            sender_account_id: "android:ordinary-001",
            channel: "android",
            status: "healthy",
            health: "healthy",
            device_ref: "mac:serial-1",
            capabilities: { like: true, comment: true, follow: true },
          },
          {
            sender_account_id: "web:legacy-002",
            channel: "web",
            status: "retired",
            health: "retired",
            capabilities: { like: true, comment: true, follow: true },
          },
        ],
        android_capacity: {
          registered: 1,
          maximum: 50,
          active_limit: 1,
          active: 0,
        },
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
            sender_account_id: "android:ordinary-001",
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
  await page.route("**/api/public-outreach/devices/*/control", (route) =>
    route.fulfill({
      json: {
        ok: true,
        device_ref: "mac:serial-1",
        results: [{ nodes: [{ text: "Ready", resource_id: "app:id/title" }] }],
      },
    }),
  );
  await page.route("**/api/public-outreach/devices/*/takeover", (route) =>
    route.fulfill({
      json: {
        ok: true,
        device_ref: "mac:serial-1",
        scrcpy: ["scrcpy", "-s", "serial-1"],
      },
    }),
  );
  await page.route("**/api/public-outreach/tasks/task-like-001", (route) =>
    route.fulfill({
      json: {
        task_id: "task-like-001",
        creator_uid: "creator-001",
        sequence_no: 1,
        sender_account_id: "android:ordinary-001",
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
  await page.route(
    "**/api/public-outreach/tasks/task-like-001/retry",
    (route) =>
      route.fulfill({
        json: {
          task_id: "task-like-001",
          creator_uid: "creator-001",
          sequence_no: 1,
          sender_account_id: "android:ordinary-001",
          action: "like",
          current_action: "like",
          state: "pending",
          receipt_state: "verified",
          attempt_count: 1,
          receipts: [],
        },
      }),
  );
  await page.route(
    "**/api/public-outreach/tasks/task-like-001/takeover",
    (route) =>
      route.fulfill({
        json: {
          task_id: "task-like-001",
          creator_uid: "creator-001",
          sequence_no: 1,
          sender_account_id: "android:ordinary-001",
          action: "like",
          current_action: "like",
          state: "failed",
          receipt_state: "unavailable",
          attempt_count: 1,
          receipts: [],
        },
      }),
  );
  await page.route(
    "**/api/public-outreach/tasks/task-like-001/unknown",
    (route) =>
      route.fulfill({
        json: {
          task_id: "task-like-001",
          creator_uid: "creator-001",
          sequence_no: 1,
          sender_account_id: "android:ordinary-001",
          action: "like",
          current_action: "like",
          state: "pending",
          receipt_state: "unknown",
          attempt_count: 1,
          receipts: [],
        },
      }),
  );
  await page.route("**/api/public-outreach/sequences/close", (route) =>
    route.fulfill({
      json: {
        claim: { claim: { status: "closed" } },
        receipt: { receipt_id: "closure-001", verified: true },
      },
    }),
  );

  await page.goto("/workspace/guild");

  await expect(
    page.getByRole("heading", { name: "Creator outreach workbench" }),
  ).toBeVisible();
  await expect(page.getByText("android:ordinary-001")).toBeVisible();
  await expect(page.getByText("Legacy account (read only)")).toBeVisible();
  await page
    .getByRole("button", { name: "Inspect UI android:ordinary-001" })
    .click();
  await expect(page.getByText(/app:id\/title/)).toBeVisible();
  await page
    .getByRole("button", { name: "Take over device android:ordinary-001" })
    .click();
  await expect(page.getByText(/scrcpy -s serial-1/)).toBeVisible();

  await page.getByLabel("Creator UID").fill("creator-001");
  await page.getByRole("button", { name: "Load tasks" }).click();
  await expect(page.getByTestId("outreach-task-task-like-001")).toBeVisible();
  await page.getByTestId("outreach-task-task-like-001").click();

  await expect(page.getByText("public_action_receipt")).toBeVisible();
  await expect(page.getByText("provider_readback")).toBeVisible();
  await page.getByTestId("outreach-retry").click();
  await page.getByTestId("outreach-takeover").click();
  await page.getByTestId("outreach-unknown").click();
  await page.getByTestId("outreach-close-sequence").click();
});
