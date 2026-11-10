import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Transaction } from 'yjs';
import {
  CaptureUpdateAction, Excalidraw, MainMenu, WelcomeScreen,
  convertToExcalidrawElements,
} from '@excalidraw/excalidraw';
import type { AppState, Collaborator, ExcalidrawImperativeAPI, SocketId } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import '@excalidraw/excalidraw/index.css';
import { createSession } from './session';
import { fingerprint, LOCAL_ORIGIN, type BoardElement } from './model';
import { loadImage, uploadImage } from './assets';

type Session = ReturnType<typeof createSession>;
type Person = { id: number; name: string; color: string };

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH: string;
    __board?: {
      scene(): readonly ExcalidrawElement[];
      model(): BoardElement[];
      files(): string[];
      viewport(): { x: number; y: number; zoom: number };
      patch(id: string, changes: Record<string, unknown>): void;
      add(id: string, x?: number): void;
      undo(): void;
      localTransactions(): number;
    };
  }
}
window.EXCALIDRAW_ASSET_PATH = '/excalidraw/';

function Mark() {
  return <span className="mark" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.6"/><rect x="10" y="10" width="11" height="11" rx="2" fill="currentColor"/></svg></span>;
}

export function App() {
  const [name, setName] = useState(sessionStorage.getItem('board-name') ?? '');
  const [entered, setEntered] = useState(false);
  function enter(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim().slice(0, 24);
    if (!trimmed) return;
    setName(trimmed);
    sessionStorage.setItem('board-name', trimmed);
    setEntered(true);
  }
  if (entered) return <Board name={name} onLeave={() => setEntered(false)} />;
  return <main className="entry">
    <div className="entry-brand"><Mark /><span>Board Lab</span><span className="tag">Исследовательский прототип</span></div>
    <section className="entry-content">
      <div className="entry-intro"><p className="subtle">Одна доска. Общая работа.</p><h1>Давайте думать<br />на одном холсте.</h1><p>Рисуйте, связывайте идеи и проверяйте, как изменения появляются у коллег в реальном времени.</p>
        <div className="stack-label">Excalidraw <span>+</span> Yjs <span>+</span> Hocuspocus</div>
      </div>
      <form className="entry-form" onSubmit={enter}>
        <span className="board-id">Тестовая доска / team-board</span>
        <h2>Присоединиться к команде</h2>
        <label htmlFor="name">Как вас показать на доске?</label>
        <input id="name" value={name} onChange={event => setName(event.target.value)} maxLength={24} placeholder="Например, Саша" autoComplete="nickname" required autoFocus />
        <p className="field-hint">Имя увидят другие участники. До 24 символов.</p>
        <button className="primary" type="submit" disabled={!name.trim()}>Открыть общий холст <span aria-hidden="true">↗</span></button>
        <p className="access-note">Без авторизации. Любой, кто имеет доступ к локальному серверу, может читать и менять доску.</p>
      </form>
    </section>
    <footer className="entry-footer">Технологический spike · данные хранятся локально · не для конфиденциальных данных</footer>
  </main>;
}

function Board({ name, onLeave }: { name: string; onLeave(): void }) {
  const [session] = useState<Session>(() => createSession(name));
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState(() => session.provider.configuration.websocketProvider.status);
  const [closing, setClosing] = useState(false);
  const [syncedOnce, setSyncedOnce] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pending, setPending] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [count, setCount] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [help, setHelp] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [copied, setCopied] = useState(false);
  const baseline = useRef(new Map<string, string>());
  const rendering = useRef(false);
  const ready = useRef(false);
  const loadingFiles = useRef(new Set<string>());
  const fileInput = useRef<HTMLInputElement>(null);
  const localCount = useRef(0);
  const lastPointer = useRef(0);

  useEffect(() => () => session.destroy(), [session]);

  useEffect(() => {
    const { provider } = session;
    const socket = provider.configuration.websocketProvider;
    const updateStatus = () => {
      setStatus(socket.status);
      setClosing(socket.webSocket?.readyState === WebSocket.CLOSING);
    };
    const onSynced = ({ state }: { state: boolean }) => {
      if (state) { ready.current = true; setSyncedOnce(true); }
    };
    const updatePending = () => setPending(provider.hasUnsyncedChanges);
    socket.on('status', updateStatus);
    provider.on('synced', onSynced);
    provider.on('unsyncedChanges', updatePending);
    updateStatus();
    if (provider.synced) onSynced({ state: true });
    return () => {
      socket.off('status', updateStatus); provider.off('synced', onSynced); provider.off('unsyncedChanges', updatePending);
    };
  }, [session]);

  useEffect(() => {
    if (!api) return;
    const { doc, model, provider } = session;
    let disposed = false;
    function fetchFiles(elements: readonly BoardElement[]) {
      for (const element of elements) {
        if (element.type !== 'image' || element.isDeleted || typeof element.fileId !== 'string') continue;
        const id = element.fileId;
        if (api!.getFiles()[id] || loadingFiles.current.has(id)) continue;
        loadingFiles.current.add(id);
        void loadImage(id).then(file => { if (!disposed) api!.addFiles([file]); })
          .catch(cause => { if (!disposed) setError(String(cause.message)); })
          .finally(() => loadingFiles.current.delete(id));
      }
    }
    function render() {
      const scene = model.read();
      baseline.current = new Map(scene.map(element => [element.id, fingerprint(element)]));
      rendering.current = true;
      api!.updateScene({ elements: scene as unknown as ExcalidrawElement[], captureUpdate: CaptureUpdateAction.NEVER });
      api!.history.clear();
      rendering.current = false;
      setCount(scene.filter(element => !element.isDeleted).length);
      setCanUndo(model.undo.canUndo()); setCanRedo(model.undo.canRedo());
      fetchFiles(scene);
    }
    function updateUndo() { setCanUndo(model.undo.canUndo()); setCanRedo(model.undo.canRedo()); }
    function transaction(transaction: Transaction) {
      // Sync handshakes/echoed updates can produce empty Yjs transactions.
      // Replacing the scene for those interrupts a native drawing gesture.
      const changedBoard = [...transaction.changedParentTypes.keys()].some(type => Object.is(type, model.elements) || Object.is(type, model.deleted));
      if (!changedBoard) { updateUndo(); return; }
      if (transaction.origin === LOCAL_ORIGIN) {
        localCount.current++;
        setCount(model.read().filter(element => !element.isDeleted).length);
        setCanUndo(model.undo.canUndo()); setCanRedo(model.undo.canRedo());
      } else render();
    }
    function presence() {
      const collaborators = new Map<SocketId, Collaborator>();
      const active: Person[] = [];
      for (const [id, state] of provider.awareness?.getStates() ?? []) {
        if (!state.user || typeof state.user.name !== 'string') continue;
        const user = state.user as { name: string; color: string };
        active.push({ id, ...user });
        if (id !== doc.clientID) collaborators.set(String(id) as SocketId, {
          username: user.name, pointer: state.pointer, button: state.button ?? 'up',
          selectedElementIds: state.selectedElementIds ?? {},
          color: { background: user.color, stroke: user.color },
        });
      }
      setPeople(active);
      api!.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER });
    }
    const retryFiles = () => fetchFiles(model.read());
    render(); presence();
    doc.on('afterTransaction', transaction);
    provider.awareness?.on('change', presence);
    provider.on('synced', retryFiles);

    // Test instrumentation is deliberately development-only. Browser tests inspect
    // the actual editor scene, not just the backing Y.Doc.
    if (import.meta.env.DEV) window.__board = {
      scene: () => api.getSceneElementsIncludingDeleted(), model: () => model.read(),
      files: () => Object.keys(api.getFiles()), localTransactions: () => localCount.current,
      viewport: () => ({ x: api.getAppState().scrollX, y: api.getAppState().scrollY, zoom: api.getAppState().zoom.value }),
      patch(id, changes) {
        const scene = api.getSceneElementsIncludingDeleted().map(element => element.id === id
          ? { ...element, ...changes, version: element.version + 1, versionNonce: Math.random() * 1e9 | 0 } : element);
        api.updateScene({ elements: scene, captureUpdate: CaptureUpdateAction.NEVER });
      },
      add(id, x = 100) {
        const elements = convertToExcalidrawElements([{ type: 'rectangle', id, x, y: 120, width: 140, height: 100 }], { regenerateIds: false });
        api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...elements], captureUpdate: CaptureUpdateAction.NEVER });
      },
      undo: () => model.undo.undo(),
    };
    return () => {
      disposed = true;
      doc.off('afterTransaction', transaction); provider.awareness?.off('change', presence); provider.off('synced', retryFiles);
      delete window.__board;
    };
  }, [api, session]);

  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.shiftKey || event.key.toLowerCase() === 'y') session.model.undo.redo();
        else session.model.undo.undo();
      }
    }
    window.addEventListener('keydown', keyboard, true);
    return () => window.removeEventListener('keydown', keyboard, true);
  }, [session]);

  function onChange(elements: readonly ExcalidrawElement[], appState: AppState) {
    if (!ready.current || rendering.current) return;
    const changed = elements.filter(element => fingerprint(element) !== baseline.current.get(element.id));
    if (changed.length) {
      baseline.current = new Map(elements.map(element => [element.id, fingerprint(element)]));
      // Native paste/drop image paths are blocked: only durable, uploaded file ids
      // may enter the shared model.
      session.model.write(changed.filter(element => element.type !== 'image' || (element.fileId && /^[a-f0-9]{64}$/.test(element.fileId))) as unknown as BoardElement[]);
      api?.history.clear();
    }
    const selected = session.provider.awareness?.getLocalState()?.selectedElementIds;
    if (fingerprint(selected) !== fingerprint(appState.selectedElementIds)) session.provider.setAwarenessField('selectedElementIds', appState.selectedElementIds);
  }

  async function insertImage(file?: File) {
    if (!file || !api) return;
    setUploading(true); setError('');
    try {
      if (status !== 'connected' || paused) throw new Error('Для добавления изображения восстановите соединение.');
      const result = await uploadImage(file);
      api.addFiles([result.file]);
      const state = api.getAppState();
      const scale = Math.min(1, 420 / result.width, 320 / result.height);
      const elements = convertToExcalidrawElements([{
        type: 'image', x: -state.scrollX + 260 / state.zoom.value, y: -state.scrollY + 180 / state.zoom.value,
        width: result.width * scale, height: result.height * scale,
        fileId: result.file.id, status: 'saved',
      }]);
      session.model.undo.stopCapturing();
      api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...elements], captureUpdate: CaptureUpdateAction.NEVER });
      session.model.undo.stopCapturing();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  }

  function toggleConnection() {
    if (!import.meta.env.DEV || closing) return;
    const socket = session.provider.configuration.websocketProvider;
    if (paused) {
      setPaused(false);
      void socket.connect();
    } else {
      socket.disconnect();
      setPaused(true);
      // disconnect initiates the close handshake. Do not report disconnected
      // until the actual provider status event, or reconnect a CLOSING socket.
      setClosing(socket.webSocket?.readyState === WebSocket.CLOSING);
    }
  }
  const connected = status === 'connected' && !closing;
  const statusText = closing ? 'Отключение…' : connected ? (pending ? 'Передаём изменения…' : 'Подключено') : status === 'connecting' ? 'Переподключение…' : paused ? 'Соединение отключено' : 'Соединение потеряно';

  return <main className="workspace">
    <header className="topbar">
      <div className="identity"><Mark /><div><h1>Общий холст <span className="tag">Lab</span></h1><p>Командная доска / team-board</p></div></div>
      <div className="connection" role="status" data-testid="connection" data-state={closing ? 'closing' : status}><span className={`status-dot ${connected ? 'online' : 'offline'}`} />{statusText}</div>
      <div className="participants" aria-label="Активные участники" data-testid="participants">
        {people.map(person => <span className="person" key={person.id} title={person.name} style={{ '--person-color': person.color } as React.CSSProperties}><span className="avatar">{person.name.slice(0, 1).toUpperCase()}</span><span>{person.name}{person.id === session.doc.clientID ? ' (вы)' : ''}</span></span>)}
      </div>
      <button onClick={() => { void navigator.clipboard.writeText(window.location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => setError('Скопируйте URL из адресной строки.')); }}>{copied ? 'Ссылка скопирована' : 'Копировать ссылку'}</button>
    </header>
    <nav className="board-actions" aria-label="Действия с доской">
      <div className="action-group"><button onClick={() => session.model.undo.undo()} disabled={!canUndo} title="Локальный undo Yjs · Ctrl+Z" aria-label="Отменить моё"><span aria-hidden="true">↶</span> <span>Отменить моё</span></button><button onClick={() => session.model.undo.redo()} disabled={!canRedo} title="Ctrl+Shift+Z" aria-label="Повторить"><span aria-hidden="true">↷</span> <span>Повторить</span></button><span className="divider" /><button onClick={() => fileInput.current?.click()} disabled={uploading || !connected}>{uploading ? 'Загрузка…' : '+ Изображение'}</button><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Добавить изображение" onChange={event => void insertImage(event.target.files?.[0])} /></div>
      <div className="action-group"><button onClick={() => api?.scrollToContent(undefined, { fitToContent: true })}>Вся доска</button>{import.meta.env.DEV && <button onClick={toggleConnection} disabled={closing} data-testid="toggle-connection" title="Dev: управляет WebSocket только этой вкладки">{paused ? 'Подключить синхронизацию' : 'Отключить синхронизацию'}</button>}<button onClick={() => setHelp(!help)} aria-expanded={help} aria-controls="lab-notes">О прототипе</button></div>
    </nav>
    {error && <div className="error-banner" role="alert">{error}<button onClick={() => { setError(''); if (api) { const image = session.model.read().find(e => e.type === 'image' && !e.isDeleted && typeof e.fileId === 'string' && !api.getFiles()[e.fileId]); if (image) void loadImage(String(image.fileId)).then(file => api.addFiles([file])).catch(e => setError(e.message)); } }}>Повторить / закрыть</button></div>}
    {(!connected && syncedOnce) && <div className="offline-banner">Изменения остаются в памяти этой вкладки и объединятся после подключения. Не перезагружайте страницу: offline-копия на диск не сохраняется.</div>}
    <div className="board-body">
      <section className="editor" aria-label="Интерактивный холст" onDragOverCapture={event => event.preventDefault()} onDropCapture={event => { event.preventDefault(); event.stopPropagation(); setError('Для изображения используйте кнопку «+ Изображение» (до 2 МиБ).'); }}>
        <Excalidraw excalidrawAPI={setApi} onChange={onChange} langCode="ru-RU" isCollaborating autoFocus handleKeyboardGlobally aiEnabled={false} validateEmbeddable={false} viewModeEnabled={!syncedOnce} initialData={{ appState: { viewBackgroundColor: '#ffffff', currentItemFontFamily: 2 } }}
          onPointerUpdate={({ pointer, button }) => { const now = performance.now(); if (now - lastPointer.current > 45) { session.provider.setAwarenessField('pointer', pointer); session.provider.setAwarenessField('button', button); lastPointer.current = now; } }}
          onPointerUp={() => session.model.undo.stopCapturing()}
          onPaste={data => { if (data.files?.length) { setError('Для изображения используйте кнопку «+ Изображение».'); return true; } return false; }}
          UIOptions={{ tools: { image: false }, canvasActions: { loadScene: false, clearCanvas: false, changeViewBackgroundColor: false, saveToActiveFile: false, toggleTheme: false, export: false, saveAsImage: true } }}>
          <MainMenu><MainMenu.DefaultItems.SaveAsImage /><MainMenu.DefaultItems.Help /></MainMenu>
          <WelcomeScreen><WelcomeScreen.Center><WelcomeScreen.Center.Heading>Место для общих идей</WelcomeScreen.Center.Heading><div className="canvas-hint">Нарисуйте первую фигуру или нажмите T, чтобы добавить текст.<br />Откройте этот же адрес в другом браузере — и работайте вместе.</div></WelcomeScreen.Center><WelcomeScreen.Hints.MenuHint /><WelcomeScreen.Hints.ToolbarHint /><WelcomeScreen.Hints.HelpHint /></WelcomeScreen>
        </Excalidraw>
        {!syncedOnce && <div className="loading-overlay" role="status">Получаем доску с локального сервера…</div>}
      </section>
      {help && <aside id="lab-notes" className="lab-notes"><div className="notes-heading"><h2>Внутри эксперимента</h2><button onClick={() => setHelp(false)} aria-label="Закрыть описание">×</button></div><p>Редактор Excalidraw. Объекты — в Yjs. Доставка — Hocuspocus. Состояние и изображения — в локальной SQLite.</p><h3>Попробуйте вдвоём</h3><ol><li>Откройте ссылку в другом браузере и задайте имя.</li><li>Добавьте фигуру, текст и стрелку.</li>{import.meta.env.DEV && <li>Нажмите «Отключить синхронизацию», переместите объект и подключитесь снова. Это dev-проверка текущего клиента, а не всех сетевых сбоев.</li>}</ol><h3>Что важно знать</h3><p>Одновременное изменение одного объекта выбирает одну целую версию. Удаление приоритетнее параллельного редактирования.</p><p>«Отменить моё» — эксперимент с Y.UndoManager. Границы жестов и связанные объекты требуют дополнительной проверки.</p><p>Стикер — прямоугольник с текстом, без отдельной модели стикеров.</p><p>Картинки: PNG / JPEG / WebP до 2 МиБ. Добавляются только при подключении.</p><h3>Открытый доступ</h3><p>Имя не является аккаунтом. Любой с доступом к серверу может менять и удалять данные. Production-защита не реализована.</p><button onClick={onLeave}>Выйти и сменить имя</button></aside>}
    </div>
    <footer className="board-footer"><span><span className="status-dot" /> Локальный spike · без авторизации</span><span data-testid="object-count">Объектов: {count}</span><span>Панорамирование: Space + перетаскивание · масштаб: Ctrl + колесо</span></footer>
  </main>;
}
