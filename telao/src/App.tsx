import { useEffect } from 'react';
import Arena from './components/Arena';
import Voting from './components/Voting';
import Scoreboard from './components/Scoreboard';
import { AdminPanel } from './components/AdminPanel';
import WorldArena from './components/WorldArena';
import { WorldControl } from './components/WorldControl';
import BenchArena from './components/BenchArena';
import { BenchControl } from './components/BenchControl';

type View = 'arena' | 'voting' | 'scoreboard' | 'admin' | 'world' | 'control' | 'bench' | 'bench-control' | 'bench-challenge';

const PAGE_TITLES: Record<View, string> = {
  arena: 'Arena | Gambiarra',
  voting: 'Votação | Gambiarra',
  scoreboard: 'Placar | Gambiarra',
  admin: 'Admin | Gambiarra',
  world: 'Mundo | Gambiarra',
  control: 'Controle do Mundo | Gambiarra',
  bench: 'Bench | Gambiarra',
  'bench-control': 'Controle do Bench | Gambiarra',
  'bench-challenge': 'Tool Call Challenge | Gambiarra',
};

function getViewFromPath(): View {
  const path = window.location.pathname;
  if (path === '/voting') return 'voting';
  if (path === '/scoreboard') return 'scoreboard';
  if (path === '/admin') return 'admin';
  if (path === '/world') return 'world';
  if (path === '/control') return 'control';
  if (path === '/bench') return 'bench';
  if (path === '/bench-control') return 'bench-control';
  if (path === '/bench-challenge') return 'bench-challenge';
  return 'arena';
}

function App() {
  const view = getViewFromPath();

  useEffect(() => {
    document.title = PAGE_TITLES[view];
  }, [view]);

  const renderView = () => {
    switch (view) {
      case 'voting':
        return <Voting />;
      case 'scoreboard':
        return <Scoreboard />;
      case 'admin':
        return <AdminPanel />;
      case 'world':
        return <WorldArena />;
      case 'control':
        return <WorldControl />;
      case 'bench':
        return <BenchArena />;
      case 'bench-challenge':
        return <BenchArena view="challenge" />;
      case 'bench-control':
        return <BenchControl />;
      default:
        return <Arena />;
    }
  };

  return (
    <div className="min-h-screen bg-dark">
      {renderView()}
    </div>
  );
}

export default App;
