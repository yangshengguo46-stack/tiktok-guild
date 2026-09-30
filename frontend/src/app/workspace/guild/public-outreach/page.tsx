"use client";

import { RefreshCwIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PublicOutreachAccountPool,
  type PublicOutreachAccount,
} from "@/components/workspace/guild/public-outreach-account-pool";
import { PublicOutreachReceipts } from "@/components/workspace/guild/public-outreach-receipts";
import {
  PublicOutreachTaskList,
  type PublicOutreachTask,
} from "@/components/workspace/guild/public-outreach-task-list";
import {
  WorkspaceBody,
  WorkspaceContainer,
  WorkspaceHeader,
} from "@/components/workspace/workspace-container";
import { fetch as fetchWithAuth } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";
import { useI18n } from "@/core/i18n/hooks";

type AccountPayload = {
  accounts: PublicOutreachAccount[];
  android_capacity: {
    registered: number;
    maximum: number;
    active_limit: number;
    active: number;
    ready: number;
  };
  operator: { external_writes_enabled: boolean };
};

type TaskDetail = PublicOutreachTask & {
  receipts: Array<{
    receipt_id?: string;
    kind?: string;
    verified?: boolean;
    verification_source?: string;
    created_at?: string;
  }>;
};

type PublicOutreachCopy = {
  title: string;
  description: string;
  operatorUnavailable: string;
  reload: string;
  creatorUid: string;
  sequenceNo: string;
  loadTasks: string;
  accountPool: {
    title: string;
    android: string;
    history: string;
    healthy: string;
    attention: string;
    active: string;
    batchCapacity: string;
    registered: string;
    maximum: string;
    ready: string;
    pause: string;
    resume: string;
    observe: string;
    manualControl: string;
    deviceResult: string;
    manualCommand: string;
    noNodes: string;
  };
  taskList: {
    title: string;
    empty: string;
    action: string;
    state: string;
    receipt: string;
    takeover: string;
    verified: string;
    unknown: string;
    retry: string;
    execute: string;
    manualTakeover: string;
    markUnknown: string;
    closeSequence: string;
  };
  receipts: {
    title: string;
    empty: string;
    verified: string;
    unknown: string;
    source: string;
  };
};

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail =
      payload && typeof payload.detail === "string"
        ? payload.detail
        : `Request failed (${response.status})`;
    throw new Error(detail);
  }
  return payload as T;
}

export default function PublicOutreachWorkbenchPage() {
  const { t } = useI18n();
  const copy = (
    t.guildWorkbench as typeof t.guildWorkbench & {
      publicOutreach: PublicOutreachCopy;
    }
  ).publicOutreach;
  const [accounts, setAccounts] = useState<AccountPayload | null>(null);
  const [tasks, setTasks] = useState<PublicOutreachTask[]>([]);
  const [selectedTask, setSelectedTask] = useState<TaskDetail | null>(null);
  const [creatorUid, setCreatorUid] = useState("");
  const [sequenceNo, setSequenceNo] = useState("1");
  const [loading, setLoading] = useState(true);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyDeviceRef, setBusyDeviceRef] = useState<string | null>(null);
  const [deviceResult, setDeviceResult] = useState<{
    device_ref: string;
    nodes?: Array<{
      text?: string;
      resource_id?: string;
      description?: string;
      class?: string;
    }>;
    scrcpy?: string[];
  } | null>(null);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchWithAuth(
        `${getBackendBaseURL()}/api/public-outreach/accounts`,
      );
      setAccounts(await readJson<AccountPayload>(response));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : copy.operatorUnavailable,
      );
    } finally {
      setLoading(false);
    }
  }, [copy.operatorUnavailable]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  async function loadTasks(event?: FormEvent) {
    event?.preventDefault();
    if (!creatorUid.trim()) return;
    setLoadingTasks(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        creator_uid: creatorUid.trim(),
        sequence_no: sequenceNo,
      });
      const response = await fetchWithAuth(
        `${getBackendBaseURL()}/api/public-outreach/tasks?${params.toString()}`,
      );
      const payload = await readJson<{ tasks: PublicOutreachTask[] }>(response);
      setTasks(payload.tasks);
      setSelectedTask(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : copy.operatorUnavailable,
      );
    } finally {
      setLoadingTasks(false);
    }
  }

  async function selectTask(task: PublicOutreachTask) {
    setSelectedTask(null);
    try {
      const response = await fetchWithAuth(
        `${getBackendBaseURL()}/api/public-outreach/tasks/${encodeURIComponent(task.task_id)}`,
      );
      setSelectedTask(await readJson<TaskDetail>(response));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : copy.operatorUnavailable,
      );
    }
  }

  async function updateAccount(
    account: PublicOutreachAccount,
    action: "pause" | "resume",
  ) {
    setError(null);
    try {
      const response = await fetchWithAuth(
        `${getBackendBaseURL()}/api/public-outreach/accounts/${encodeURIComponent(account.sender_account_id)}/${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: `workbench_${action}` }),
        },
      );
      await readJson(response);
      await loadAccounts();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : copy.operatorUnavailable,
      );
    }
  }

  async function operateDevice(
    account: PublicOutreachAccount,
    action: "observe" | "takeover",
  ) {
    if (!account.device_ref) return;
    setError(null);
    setBusyDeviceRef(account.device_ref);
    setDeviceResult(null);
    try {
      const endpoint = action === "observe" ? "control" : "takeover";
      const response = await fetchWithAuth(
        `${getBackendBaseURL()}/api/public-outreach/devices/${encodeURIComponent(account.device_ref)}/${endpoint}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            action === "observe" ? { commands: [{ type: "observe" }] } : {},
          ),
        },
      );
      const result = await readJson<{
        ok: boolean;
        error_code?: string;
        device_ref: string;
        results?: Array<{
          nodes?: Array<{
            text?: string;
            resource_id?: string;
            description?: string;
            class?: string;
          }>;
        }>;
        scrcpy?: string[];
      }>(response);
      if (!result.ok)
        throw new Error(result.error_code ?? copy.operatorUnavailable);
      setDeviceResult({
        device_ref: result.device_ref,
        nodes: result.results?.[0]?.nodes,
        scrcpy: result.scrcpy,
      });
      if (action === "takeover") await loadAccounts();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : copy.operatorUnavailable,
      );
    } finally {
      setBusyDeviceRef(null);
    }
  }

  async function runTaskAction(
    action: "execute" | "retry" | "takeover" | "unknown",
    body?: Record<string, string>,
  ) {
    if (!selectedTask) return;
    setActionBusy(true);
    setError(null);
    try {
      const response = await fetchWithAuth(
        `${getBackendBaseURL()}/api/public-outreach/tasks/${encodeURIComponent(selectedTask.task_id)}/${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        },
      );
      const updated = await readJson<TaskDetail>(response);
      setSelectedTask(updated);
      setTasks((current) =>
        current.map((task) =>
          task.task_id === updated.task_id ? { ...task, ...updated } : task,
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : copy.operatorUnavailable,
      );
    } finally {
      setActionBusy(false);
    }
  }

  async function closeSequence() {
    if (!creatorUid.trim()) return;
    setActionBusy(true);
    setError(null);
    try {
      const response = await fetchWithAuth(
        `${getBackendBaseURL()}/api/public-outreach/sequences/close`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            creator_uid: creatorUid.trim(),
            sequence_no: Number(sequenceNo),
            reason: "workbench_close_sequence",
          }),
        },
      );
      await readJson(response);
      await loadTasks();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : copy.operatorUnavailable,
      );
    } finally {
      setActionBusy(false);
    }
  }

  const selectedReceipts = useMemo(
    () => selectedTask?.receipts ?? [],
    [selectedTask],
  );

  return (
    <WorkspaceContainer>
      <WorkspaceHeader />
      <WorkspaceBody>
        <section className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8">
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">{copy.title}</h1>
              <p className="text-muted-foreground mt-2 text-sm">
                {copy.description}
              </p>
            </div>
            <Button
              onClick={() => void loadAccounts()}
              size="sm"
              variant="outline"
            >
              <RefreshCwIcon />
              {copy.reload}
            </Button>
          </header>

          {error ? (
            <Alert variant="destructive">
              <AlertTitle>{t.common.error}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {loading ? (
            <div className="text-muted-foreground py-12 text-sm" role="status">
              {t.common.loading}
            </div>
          ) : accounts ? (
            <PublicOutreachAccountPool
              accounts={accounts.accounts}
              labels={copy.accountPool}
              onPause={(account) => void updateAccount(account, "pause")}
              onResume={(account) => void updateAccount(account, "resume")}
              onObserve={(account) => void operateDevice(account, "observe")}
              onTakeover={(account) => void operateDevice(account, "takeover")}
              busyDeviceRef={busyDeviceRef}
              androidCapacity={accounts.android_capacity}
            />
          ) : null}

          {deviceResult ? (
            <section
              className="border-border/70 rounded-lg border p-4"
              aria-live="polite"
            >
              <h2 className="font-medium">
                {copy.accountPool.deviceResult}: {deviceResult.device_ref}
              </h2>
              {deviceResult.scrcpy ? (
                <p className="mt-2 text-sm">
                  {copy.accountPool.manualCommand}:{" "}
                  <code>{deviceResult.scrcpy.join(" ")}</code>
                </p>
              ) : null}
              {deviceResult.nodes ? (
                deviceResult.nodes.length ? (
                  <pre className="bg-muted/30 mt-2 max-h-64 overflow-auto rounded p-2 text-xs">
                    {JSON.stringify(deviceResult.nodes, null, 2)}
                  </pre>
                ) : (
                  <p className="text-muted-foreground mt-2 text-sm">
                    {copy.accountPool.noNodes}
                  </p>
                )
              ) : null}
            </section>
          ) : null}

          <section className="border-border/70 rounded-lg border p-4">
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={loadTasks}
            >
              <label className="grid min-w-56 flex-1 gap-1 text-sm">
                <span>{copy.creatorUid}</span>
                <Input
                  aria-label={copy.creatorUid}
                  placeholder={copy.creatorUid}
                  value={creatorUid}
                  onChange={(event) => setCreatorUid(event.target.value)}
                />
              </label>
              <label className="grid w-32 gap-1 text-sm">
                <span>{copy.sequenceNo}</span>
                <Input
                  aria-label={copy.sequenceNo}
                  min={1}
                  onChange={(event) => setSequenceNo(event.target.value)}
                  type="number"
                  value={sequenceNo}
                />
              </label>
              <Button
                disabled={loadingTasks || !creatorUid.trim()}
                type="submit"
              >
                <SearchIcon />
                {copy.loadTasks}
              </Button>
            </form>
          </section>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]">
            <PublicOutreachTaskList
              labels={copy.taskList}
              onSelect={(task) => void selectTask(task)}
              selectedTaskId={selectedTask?.task_id}
              tasks={tasks}
            />
            <PublicOutreachReceipts
              labels={copy.receipts}
              receipts={selectedReceipts}
            />
          </div>
          {selectedTask ? (
            <section className="border-border/70 rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  data-testid="outreach-execute"
                  disabled={
                    actionBusy ||
                    !accounts?.operator?.external_writes_enabled ||
                    selectedTask.state !== "pending"
                  }
                  onClick={() => void runTaskAction("execute")}
                  size="sm"
                >
                  {copy.taskList.execute}
                </Button>
                <Button
                  data-testid="outreach-retry"
                  disabled={actionBusy}
                  onClick={() => void runTaskAction("retry")}
                  size="sm"
                  variant="outline"
                >
                  {copy.taskList.retry}
                </Button>
                <Button
                  data-testid="outreach-takeover"
                  disabled={actionBusy}
                  onClick={() =>
                    void runTaskAction("takeover", {
                      reason: "workbench_manual_takeover",
                    })
                  }
                  size="sm"
                  variant="outline"
                >
                  {copy.taskList.manualTakeover}
                </Button>
                <Button
                  data-testid="outreach-unknown"
                  disabled={actionBusy}
                  onClick={() =>
                    void runTaskAction("unknown", {
                      reason: "workbench_provider_unknown",
                    })
                  }
                  size="sm"
                  variant="outline"
                >
                  {copy.taskList.markUnknown}
                </Button>
                <Button
                  data-testid="outreach-close-sequence"
                  disabled={actionBusy}
                  onClick={() => void closeSequence()}
                  size="sm"
                  variant="destructive"
                >
                  {copy.taskList.closeSequence}
                </Button>
              </div>
            </section>
          ) : null}
        </section>
      </WorkspaceBody>
    </WorkspaceContainer>
  );
}
