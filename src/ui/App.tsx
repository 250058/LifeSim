import { useGame } from './store';
import { TitleScreen } from './TitleScreen';
import { GameScreen } from './GameScreen';
import { DeathScreen } from './DeathScreen';

export function App() {
  const screen = useGame((s) => s.screen);
  const game = useGame((s) => s.game);
  if (screen === 'title' || !game) return <TitleScreen />;
  if (game.phase === 'dead' && game.summary) return <DeathScreen game={game} />;
  return <GameScreen game={game} />;
}
