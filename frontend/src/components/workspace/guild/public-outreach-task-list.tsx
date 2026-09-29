"use client";

import { ChevronRightIcon, ListChecksIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type PublicOutreachTask = {
  task_id: string;
  creator_uid: string;
  sequence_no: number;
  sender_account_id: string;
  action: string;
  current_action: string;
  state: string;
  receipt_state: string;
  manual_takeover_reason?: string | null;
  attempt_count: number;
};

type Labels = {
  title: string;
  empty: string;
  action: string;
  state: string;
  receipt: string;
  takeover: string;
  verified: string;
  unknown: string;
};

export function PublicOutreachTaskList({
  tasks,
  labels,
  selectedTaskId,
  onSelect,
}: {
  tasks: PublicOutreachTask[];
  labels: Labels;
  selectedTaskId?: string | null;
  onSelect?: (task: PublicOutreachTask) => void;
}) {
  return (
    <Card className="rounded-lg shadow-none">
      <CardHeader className="gap-1">
        <CardTitle className="flex items-center gap-2">
          <ListChecksIcon className="size-4" />
          {labels.title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {tasks.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">{labels.empty}</p>
        ) : (
          <div className="divide-border divide-y">
            {tasks.map((task) => (
              <button
                className="hover:bg-muted/40 flex w-full items-center justify-between gap-3 py-3 text-left"
                data-selected={
                  selectedTaskId === task.task_id ? "true" : undefined
                }
                data-testid={`outreach-task-${task.task_id}`}
                key={task.task_id}
                onClick={() => onSelect?.(task)}
                type="button"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {task.creator_uid} · {task.action}
                  </div>
                  <div className="text-muted-foreground mt-1 text-xs">
                    {labels.state}: {task.state} · {labels.receipt}:{" "}
                    {task.receipt_state === "verified"
                      ? labels.verified
                      : labels.unknown}
                    {task.manual_takeover_reason
                      ? ` · ${labels.takeover}: ${task.manual_takeover_reason}`
                      : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      task.state === "completed" ? "secondary" : "outline"
                    }
                  >
                    {task.current_action}
                  </Badge>
                  <ChevronRightIcon className="text-muted-foreground size-4" />
                </div>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
