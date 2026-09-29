"use client";

import {
  CheckCircle2Icon,
  CircleAlertIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type PublicOutreachAccount = {
  sender_account_id: string;
  channel: "web" | "ios";
  status: string;
  health: string;
  device_ref?: string | null;
  capabilities?: Record<string, unknown>;
  last_health_at?: string | null;
};

type Labels = {
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

export function PublicOutreachAccountPool({
  accounts,
  webBatchCapacity,
  iosReadiness,
  labels,
  onPause,
  onResume,
}: {
  accounts: PublicOutreachAccount[];
  webBatchCapacity: {
    registered: number;
    maximum: number;
    active_limit: number;
    active: number;
    ready?: number;
  };
  iosReadiness: { registered: number; ready: number };
  labels: Labels;
  onPause?: (account: PublicOutreachAccount) => void;
  onResume?: (account: PublicOutreachAccount) => void;
}) {
  return (
    <Card className="rounded-lg shadow-none">
      <CardHeader className="gap-1">
        <CardTitle>{labels.title}</CardTitle>
        <div className="text-muted-foreground text-sm">
          {labels.batchCapacity}: {webBatchCapacity.active}/
          {webBatchCapacity.active_limit} · {labels.registered}:{" "}
          {webBatchCapacity.registered}/{webBatchCapacity.maximum}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="border-border/70 bg-muted/20 rounded-md border px-4 py-3 text-sm">
            <div className="text-muted-foreground">{labels.web}</div>
            <div className="mt-1 font-medium">
              {webBatchCapacity.active}/{webBatchCapacity.active_limit}{" "}
              {labels.active} · {webBatchCapacity.ready ?? 0} {labels.ready}
            </div>
          </div>
          <div className="border-border/70 bg-muted/20 rounded-md border px-4 py-3 text-sm">
            <div className="text-muted-foreground">{labels.iosReadiness}</div>
            <div className="mt-1 font-medium">
              {iosReadiness.ready}/{iosReadiness.registered || 0} {labels.ready}
            </div>
          </div>
        </div>
        <div className="divide-border divide-y">
          {accounts.length === 0 ? (
            <p className="text-muted-foreground py-4 text-sm">
              {labels.attention}
            </p>
          ) : (
            accounts.map((account) => {
              const healthy = [
                "enabled",
                "healthy",
                "ready",
                "active",
              ].includes(account.health);
              return (
                <div
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                  key={account.sender_account_id}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    {healthy ? (
                      <CheckCircle2Icon className="size-4 shrink-0 text-emerald-600" />
                    ) : (
                      <CircleAlertIcon className="size-4 shrink-0 text-amber-600" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {account.sender_account_id}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {account.channel === "web" ? labels.web : labels.ios}
                        {account.device_ref ? ` · ${account.device_ref}` : ""}
                      </div>
                    </div>
                    <Badge variant={healthy ? "secondary" : "outline"}>
                      {healthy ? labels.healthy : labels.attention}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    {healthy ? (
                      <Button
                        aria-label={`${labels.pause} ${account.sender_account_id}`}
                        onClick={() => onPause?.(account)}
                        size="sm"
                        variant="outline"
                      >
                        <PauseIcon />
                        {labels.pause}
                      </Button>
                    ) : (
                      <Button
                        aria-label={`${labels.resume} ${account.sender_account_id}`}
                        onClick={() => onResume?.(account)}
                        size="sm"
                        variant="outline"
                      >
                        <PlayIcon />
                        {labels.resume}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}
