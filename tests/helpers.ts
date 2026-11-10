import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { BOARD_NAME, BoardModel, fingerprint, type BoardElement } from '../src/model.ts';

export async function until(predicate: () => unknown, message = 'condition', timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export async function client(port: number, name = 'test') {
  const doc = new Y.Doc();
  const model = new BoardModel(doc);
  // Node 24 provides native WebSocket; no polyfill is necessary.
  const provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${port}/sync`, name: BOARD_NAME, document: doc });
  provider.configuration.websocketProvider.setConfiguration({ delay: 50, minDelay: 50, maxDelay: 200 });
  provider.setAwarenessField('user', { name });
  await until(() => provider.synced, `${name} initial sync`);
  return { doc, model, provider, destroy() { provider.destroy(); model.destroy(); doc.destroy(); } };
}

export function rectangle(id: string, x = 0): BoardElement {
  return { id, type: 'rectangle', isDeleted: false, x, y: 0, width: 100, height: 80, index: 'a0' };
}

export async function converge(...clients: Awaited<ReturnType<typeof client>>[]) {
  await until(() => clients.every(c => !c.provider.hasUnsyncedChanges) &&
    clients.every(c => fingerprint(c.model.read()) === fingerprint(clients[0].model.read())), 'client convergence');
}
