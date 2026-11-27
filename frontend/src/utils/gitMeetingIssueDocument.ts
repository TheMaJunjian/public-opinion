import type { ExportData } from '../api/client';
import {
  createGitMeetingCommentRoom, GitMeetingComments, gitMeetingCommentDocument, type GitMeetingCommentSource,
} from './gitMeetingComments';

export async function createGitIssueDocument(repository: string, title: string, token: string, signal: AbortSignal) {
  const { source, room } = await createGitMeetingCommentRoom(repository, title, token, signal);
  return { source, start: gitMeetingCommentDocument(room) };
}

// Open the room identity first. The mounted workbench restores its own cursor
// and local messages before requesting the first page of missing comments.
export async function openGitIssueDocument(source: GitMeetingCommentSource, token: string, signal: AbortSignal): Promise<ExportData> {
  const room = await new GitMeetingComments(source, token).open(signal);
  return gitMeetingCommentDocument(room);
}
