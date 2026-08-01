import { useEffect, useState } from 'react';
import { MessageCanvas, MessageInspector } from './components/MessageCanvas';
import { topicRepository } from './domain/demoRepository';
import { fixtureTopic } from './domain/fixtures';
import type { RelationMessage } from './domain/messages';
import type { TopicSnapshot } from './domain/topicSnapshot';
import './App.css';

function App() {
  const [snapshot, setSnapshot] = useState<TopicSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeContainerId, setActiveContainerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    topicRepository.loadTopic(fixtureTopic.id)
      .then((loaded) => {
        setSnapshot(loaded);
        const requestedId = new URLSearchParams(window.location.search).get('msg');
        const initialId = requestedId && loaded.messages.some((message) => message.id === requestedId)
          ? requestedId
          : loaded.messages[0]?.id ?? null;
        setSelectedId(initialId);
      })
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : '无法加载议题'));
  }, []);

  const selectMessage = (id: string) => {
    setSelectedId(id);
    const url = new URL(window.location.href);
    url.searchParams.set('msg', id);
    window.history.replaceState(null, '', url);
    window.requestAnimationFrame(() => {
      const element = document.querySelector(`[data-msgid="${CSS.escape(id)}"]`) as HTMLElement | null;
      element?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    });
  };

  const activeContainer = snapshot?.messages.find((message): message is RelationMessage => message.id === activeContainerId && message.kind === 'RELATION') ?? null;
  const visibleIds = activeContainer ? new Set([activeContainer.id, ...activeContainer.targetRefs.map((target) => target.kind === 'relation' ? target.relationId : target.messageId)]) : null;

  if (error) return <main className="app-shell"><p className="error-state">{error}</p></main>;
  if (!snapshot) return <main className="app-shell"><p className="loading-state">正在建立统一消息快照...</p></main>;

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand">公论 <span>REFACTOR</span></div>
      <div className="model-status"><i /> 统一消息模型 v{snapshot.formatVersion}</div>
    </header>
    <section className="topic-bar">
      <div><p className="eyebrow">议题快照 / {snapshot.topic.status}</p><h1>{activeContainer ? `容器：${activeContainer.relationPayload?.title || activeContainer.relationType}` : snapshot.topic.title}</h1><p className="topic-body">{activeContainer ? '容器消息及其直接成员仍保持独立身份；这里只是一个视图投影。' : snapshot.topic.body}</p>{activeContainer ? <button type="button" className="exit-container" onClick={() => setActiveContainerId(null)}>返回主题画布</button> : null}</div>
      <div className="topic-stat"><strong>{snapshot.messages.length}</strong><span>可寻址消息</span></div>
    </section>
    <section className="workspace">
      <MessageCanvas snapshot={snapshot} selectedId={selectedId} onSelect={selectMessage} visibleIds={visibleIds} />
      <MessageInspector snapshot={snapshot} selectedId={selectedId} onSelect={selectMessage} onOpenContainer={(id) => { setActiveContainerId(id); selectMessage(id); }} />
    </section>
  </main>;
}

export default App;
