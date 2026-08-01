import type { TopicMessage } from './messages';

export interface TopicSnapshot {
  formatVersion: 1;
  topic: {
    id: string;
    title: string;
    body: string | null;
    status: 'OPEN' | 'ARCHIVED';
  };
  messages: TopicMessage[];
}

export interface TopicRepository {
  loadTopic(topicId: string): Promise<TopicSnapshot>;
}

/**
 * The first implementation is deliberately in-memory. The production repository
 * will persist and return this exact snapshot shape; it will not adapt legacy APIs.
 */
export class InMemoryTopicRepository implements TopicRepository {
  private readonly snapshots: TopicSnapshot[];

  constructor(snapshots: TopicSnapshot[]) {
    this.snapshots = snapshots;
  }

  async loadTopic(topicId: string): Promise<TopicSnapshot> {
    const snapshot = this.snapshots.find((entry) => entry.topic.id === topicId);
    if (!snapshot) throw new Error('议题不存在');
    return structuredClone(snapshot);
  }
}
