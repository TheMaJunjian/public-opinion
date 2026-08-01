import { fixtureSnapshot } from './fixtures';
import { InMemoryTopicRepository } from './topicSnapshot';

export const topicRepository = new InMemoryTopicRepository([fixtureSnapshot]);
