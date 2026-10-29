import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { useGame } from './ui/store';
import { SAVE_VERSION } from './engine/save';
import type { GameState } from './engine/types';
import './ui/styles.css';

interface HotBridge {
  snapshot?: (fn: () => unknown) => void;
  ready?: (fn: (data: unknown) => void) => void;
  data?: unknown;
}

declare global {
  interface Window {
    claude?: { hot?: HotBridge };
  }
}

function start(data: unknown): void {
  // 페이지가 새 버전으로 바뀌어도 하던 인생을 이어 간다
  const game = (data as { game?: GameState } | null)?.game;
  if (game && game.v === SAVE_VERSION) useGame.getState().restore(game);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

const hot = window.claude?.hot;
hot?.snapshot?.(() => ({ game: useGame.getState().game }));
if (hot?.ready) hot.ready(start);
else start(hot?.data ?? {});
