"use client";

import {
  WorkspaceBody,
  WorkspaceContainer,
  WorkspaceHeader,
} from "@/components/workspace/workspace-container";
import { useI18n } from "@/core/i18n/hooks";

export default function GuildWorkbenchPage() {
  const { t } = useI18n();

  return (
    <WorkspaceContainer>
      <WorkspaceHeader />
      <WorkspaceBody>
        <section className="mx-auto flex w-full max-w-(--container-width-md) flex-col gap-6 px-6 py-10">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold">{t.guildWorkbench.title}</h1>
            <p className="text-muted-foreground" role="status">
              {t.guildWorkbench.overviewUnavailable}
            </p>
          </div>
        </section>
      </WorkspaceBody>
    </WorkspaceContainer>
  );
}
