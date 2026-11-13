import "server-only";

import {
  accountDeletionJob,
  digestJob,
  opsAlertsJob,
  pushCleanupJob,
  unverifiedPurgeJob,
} from "./tasks";
import type { JobDef } from "./runner";

/** 调度器管理的任务清单。新增任务只加这里，并同步 docs/SCHEDULED-JOBS.md */
export function defaultJobs(): readonly JobDef[] {
  return [
    accountDeletionJob(),
    unverifiedPurgeJob({ apply: true }),
    opsAlertsJob(),
    digestJob(),
    pushCleanupJob(),
  ];
}
