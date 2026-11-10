import * as Y from 'yjs';

export const BOARD_NAME = 'team-board';
export const LOCAL_ORIGIN = Symbol('local-editor');

// An element is an atomic register: concurrent geometry edits pick one whole
// record, never mix width from one transform with points from another.
export interface BoardElement {
  id: string;
  type: string;
  isDeleted: boolean;
  index?: string | null;
  [key: string]: unknown;
}

export function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
    }
    return item;
  });
}

export class BoardModel {
  readonly elements: Y.Map<BoardElement>;
  readonly deleted: Y.Map<boolean>;
  readonly undo: Y.UndoManager;

  constructor(readonly doc: Y.Doc) {
    this.elements = doc.getMap('elements');
    this.deleted = doc.getMap('deleted');
    this.undo = new Y.UndoManager([this.elements, this.deleted], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 400,
    });
  }

  read(): BoardElement[] {
    return [...this.elements.values()].map(element => ({
      ...element,
      isDeleted: this.deleted.has(element.id),
    })).sort((a, b) => {
      const left = a.index ?? '';
      const right = b.index ?? '';
      return left < right ? -1 : left > right ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  write(changed: readonly BoardElement[]) {
    this.doc.transact(() => {
      for (const element of changed) {
        if (element.isDeleted) {
          if (this.elements.has(element.id) && !this.deleted.has(element.id)) {
            this.deleted.set(element.id, true);
          }
        } else {
          // A stale edit cannot resurrect a concurrently deleted element.
          // Only explicit Y.UndoManager undo of the deleting transaction can.
          if (this.deleted.has(element.id)) continue;
          const clone = JSON.parse(JSON.stringify(element)) as BoardElement;
          if (fingerprint(this.elements.get(element.id)) !== fingerprint(clone)) {
            this.elements.set(element.id, clone);
          }
        }
      }
    }, LOCAL_ORIGIN);
  }

  destroy() { this.undo.destroy(); }
}
