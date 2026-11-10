import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { BOARD_NAME, BoardModel } from './model';

export function createSession(name: string) {
  const doc = new Y.Doc();
  const model = new BoardModel(doc);
  const url = new URL('/sync', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const provider = new HocuspocusProvider({ url: url.href, name: BOARD_NAME, document: doc });
  provider.configuration.websocketProvider.setConfiguration({ delay: 500, minDelay: 500, maxDelay: 2000 });
  const colors = ['#24627c', '#a33f56', '#6650a4', '#407249', '#92540f'];
  const color = colors[doc.clientID % colors.length];
  const user = { name, color };
  provider.setAwarenessField('user', user);
  return {
    doc, model, provider, user,
    destroy() { provider.destroy(); model.destroy(); doc.destroy(); },
  };
}
