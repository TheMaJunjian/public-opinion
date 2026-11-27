import { GitHubRequestError } from './gitMeetingTransport';
import { forgetPendingGitDelta, gitMeetingPendingKey, loadPendingGitDelta, rememberPendingGitDelta } from './gitMeetingRetry';
import { parseEntry, type exportMeetingDelta, type MeetingEditConfirmation } from './meetingExchange';

type MeetingDelta = Awaited<ReturnType<typeof exportMeetingDelta>>;

export async function publishCloudMeetingDelta(requested: MeetingDelta, options: {
  provider: 'WPS' | 'GitHub';
  archiveKey: string;
  signal: AbortSignal;
  append: (delta: MeetingDelta) => Promise<void>;
  readForRetry: (prior: MeetingDelta) => Promise<MeetingDelta['entries']>;
}): Promise<MeetingEditConfirmation> {
  const key = await gitMeetingPendingKey(options.archiveKey, requested);
  options.signal.throwIfAborted();
  const prior = loadPendingGitDelta(key, requested);
  const delta = prior ?? requested;
  const receipt = { original: prior, saved: () => forgetPendingGitDelta(key, delta) };
  if (prior) {
    // A lost acknowledgement can hide a successful write. Match immutable IDs
    // and content before deciding whether to append the original batch again.
    const seen = new Map((await options.readForRetry(prior)).map(row => [row.id, row]));
    let missing = false;
    for (const entry of prior.entries) {
      const old = seen.get(entry.id);
      if (!old) missing = true;
      else if (JSON.stringify(parseEntry(old)) !== JSON.stringify(parseEntry(entry))) {
        throw new Error(options.provider + ' 中已有相同编号、不同内容的发言。');
      }
    }
    if (!missing) return receipt;
  }
  options.signal.throwIfAborted();
  rememberPendingGitDelta(key, delta);
  try {
    await options.append(delta);
  } catch (error) {
    if (!prior && error instanceof GitHubRequestError && error.status >= 400 && error.status < 500 && error.status !== 408) {
      forgetPendingGitDelta(key, delta);
    }
    throw error;
  }
  return receipt;
}
