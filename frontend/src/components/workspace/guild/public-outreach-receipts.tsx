"use client";

import { FileCheck2Icon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Receipt = {
  receipt_id?: string;
  kind?: string;
  verified?: boolean;
  verification_source?: string;
  created_at?: string;
};

type Labels = {
  title: string;
  empty: string;
  verified: string;
  unknown: string;
  source: string;
};

export function PublicOutreachReceipts({
  receipts,
  labels,
}: {
  receipts: Receipt[];
  labels: Labels;
}) {
  return (
    <Card className="rounded-lg shadow-none">
      <CardHeader className="gap-1">
        <CardTitle className="flex items-center gap-2">
          <FileCheck2Icon className="size-4" />
          {labels.title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {receipts.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">{labels.empty}</p>
        ) : (
          <div className="divide-border divide-y">
            {receipts.map((receipt) => (
              <div
                className="flex flex-wrap items-center justify-between gap-2 py-3"
                key={receipt.receipt_id}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {receipt.kind ?? "receipt"}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {labels.source}: {receipt.verification_source ?? "—"}
                  </div>
                </div>
                <Badge variant={receipt.verified ? "secondary" : "outline"}>
                  {receipt.verified ? labels.verified : labels.unknown}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
