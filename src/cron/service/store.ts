import fs from "node:fs";
import { normalizeCronJobIdentityFields } from "../normalize-job-identity.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { recomputeNextRuns } from "./jobs.js";
import type { CronServiceState } from "./state.js";

const AJ_MORNING_PICK_TOKEN = "[AJ_MORNING_PICK]";
const AJ_CHECKIN_TOKEN = "[AJ_CHECKIN]";

async function getFileMtimeMs(path: string): Promise<number | null> {
  try {
    const stats = await fs.promises.stat(path);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

function isLegacyAgenticJournalMorningPickJob(
  job: CronJob,
): job is CronJob & { payload: { kind: "systemEvent"; text: string } } {
  return (
    job.sessionTarget === "main" &&
    job.payload.kind === "systemEvent" &&
    job.payload.text.includes(AJ_MORNING_PICK_TOKEN)
  );
}

function resolveAgenticJournalCheckInDeliveryTarget(
  jobs: readonly CronJob[],
  agentId: string | undefined,
): CronJob["delivery"] | undefined {
  const matches = jobs.filter(
    (job) =>
      job.sessionTarget === "isolated" &&
      job.payload.kind === "agentTurn" &&
      job.payload.message.includes(AJ_CHECKIN_TOKEN) &&
      job.delivery?.mode === "announce" &&
      typeof job.delivery.channel === "string" &&
      job.delivery.channel.trim() &&
      typeof job.delivery.to === "string" &&
      job.delivery.to.trim(),
  );
  const sameAgent = matches.find((job) => job.agentId === agentId);
  return (sameAgent ?? matches[0])?.delivery;
}

function upgradeLegacyAgenticJournalMorningPickJobs(state: CronServiceState, jobs: CronJob[]) {
  for (const job of jobs) {
    if (!isLegacyAgenticJournalMorningPickJob(job)) {
      continue;
    }
    const target = resolveAgenticJournalCheckInDeliveryTarget(jobs, job.agentId);
    if (!target?.channel || !target.to) {
      continue;
    }
    const message = job.payload.text;
    job.sessionTarget = "isolated";
    job.payload = {
      kind: "agentTurn",
      message,
    };
    job.delivery = {
      mode: "announce",
      channel: target.channel,
      to: target.to,
      ...(target.accountId ? { accountId: target.accountId } : {}),
      ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
      ...(target.bestEffort === true ? { bestEffort: true } : {}),
    };
    state.deps.log.warn(
      { storePath: state.deps.storePath, jobId: job.id, name: job.name },
      "cron: upgraded legacy Agentic Journal morning-pick job to isolated explicit delivery in memory",
    );
  }
}

export async function ensureLoaded(
  state: CronServiceState,
  opts?: {
    forceReload?: boolean;
    /** Skip recomputing nextRunAtMs after load so the caller can run due
     *  jobs against the persisted values first (see onTimer). */
    skipRecompute?: boolean;
  },
) {
  // Fast path: store is already in memory. Other callers (add, list, run, …)
  // trust the in-memory copy to avoid a stat syscall on every operation.
  if (state.store && !opts?.forceReload) {
    return;
  }
  // Force reload always re-reads the file to avoid missing cross-service
  // edits on filesystems with coarse mtime resolution.

  const fileMtimeMs = await getFileMtimeMs(state.deps.storePath);
  const loaded = await loadCronStore(state.deps.storePath);
  const jobs = (loaded.jobs ?? []) as unknown as CronJob[];
  for (const job of jobs) {
    const raw = job as unknown as Record<string, unknown>;
    const { legacyJobIdIssue } = normalizeCronJobIdentityFields(raw);
    if (legacyJobIdIssue) {
      const resolvedId = typeof raw.id === "string" ? raw.id : undefined;
      state.deps.log.warn(
        { storePath: state.deps.storePath, jobId: resolvedId },
        "cron: job used legacy jobId field; normalized id in memory (run openclaw doctor --fix to persist canonical shape)",
      );
    }
    // Persisted legacy jobs may predate the required `enabled` field.
    // Keep runtime behavior backward-compatible without rewriting the store.
    if (typeof job.enabled !== "boolean") {
      job.enabled = true;
    }
  }
  upgradeLegacyAgenticJournalMorningPickJobs(state, jobs);
  state.store = {
    version: 1,
    jobs,
  };
  state.storeLoadedAtMs = state.deps.nowMs();
  state.storeFileMtimeMs = fileMtimeMs;

  if (!opts?.skipRecompute) {
    recomputeNextRuns(state);
  }
}

export function warnIfDisabled(state: CronServiceState, action: string) {
  if (state.deps.cronEnabled) {
    return;
  }
  if (state.warnedDisabled) {
    return;
  }
  state.warnedDisabled = true;
  state.deps.log.warn(
    { enabled: false, action, storePath: state.deps.storePath },
    "cron: scheduler disabled; jobs will not run automatically",
  );
}

export async function persist(state: CronServiceState, opts?: { skipBackup?: boolean }) {
  if (!state.store) {
    return;
  }
  await saveCronStore(state.deps.storePath, state.store, opts);
  // Update file mtime after save to prevent immediate reload
  state.storeFileMtimeMs = await getFileMtimeMs(state.deps.storePath);
}
