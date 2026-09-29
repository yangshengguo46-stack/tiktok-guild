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
  web_batch_capacity: {
    registered: number;
    maximum: number;
    active_limit: number;
    active: number;
  };
  ios_readiness: { registered: number; ready: number };
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
    web: string;
    ios: string;
    healthy: string;
    attention: string;
    active: string;
    batchCapacity: string;
    iosReadiness: string;
    registered: string;
    maximum: string;
    ready: string;
    pause: string;
    resume: string;
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
  const [error, setError] = useState<string | null>(null);

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
              iosReadiness={accounts.ios_readiness}
              labels={copy.accountPool}
              onPause={(account) => void updateAccount(account, "pause")}
              onResume={(account) => void updateAccount(account, "resume")}
              webBatchCapacity={accounts.web_batch_capacity}
            />
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
        </section>
      </WorkspaceBody>
    </WorkspaceContainer>
  );
}
