import type { DemoMessage } from '../utils/modelBridge';
import { MessageSelfStake } from './MessageAuthors';

/** The card's sender investment is independent of community totals and displayed-body authors. */
export default function MessageCardSelfStake({ message }: { message: DemoMessage }) {
  if (!message.authorInvestment && !message.spending) return null;
  return <span className="message-card-self-stake" style={{ display: 'none' }}>
    <MessageSelfStake message={message} />
  </span>;
}
