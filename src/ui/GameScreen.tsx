import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { TAG_BY_ID, REGION_BY_ID } from '../engine/data';
import { endTurn } from '../engine/game';
import { formatWonShort } from '../engine/format';
import { inPrison } from '../engine/scope';
import { STAT_KEYS, type GameState, type LogEntry } from '../engine/types';
import { EventCard } from './EventCard';
import { IconActivity, IconBook, IconPeople, IconWon, IconYear } from './icons';
import { gradeLabel, SCHOOL_LABEL, STAT_LABEL } from './labels';
import { SheetHost } from './Sheets';
import { useGame, type Sheet } from './store';

export function GameScreen({ game }: { game: GameState }) {
  const sheet = useGame((s) => s.sheet);
  const showCard = game.phase === 'event' && game.card;
  return (
    <div className="game">
      <Header game={game} />
      <LifeLog game={game} />
      <TabBar game={game} />
      {sheet && <SheetHost game={game} sheet={sheet} />}
      {showCard && <EventCard game={game} card={game.card!} />}
    </div>
  );
}

// ── 상단: 이름·나이·연도·현금, 능력치 6개 ─────────────────

function Header({ game }: { game: GameState }) {
  const ch = game.ch;
  const openSheet = useGame((s) => s.openSheet);
  const school = gradeLabel(ch.edu.status, ch.age);
  const role =
    school ??
    (ch.military.status === 'serving'
      ? '군 복무'
      : inPrison(game)
        ? '수감 중'
        : ch.career.title ?? (ch.edu.status === 'university' ? '대학생' : ch.age < 7 ? SCHOOL_LABEL[ch.edu.status] : ch.career.retired ? '은퇴' : '무직'));
  const tags = Object.keys(ch.flags)
    .map((id) => TAG_BY_ID.get(id))
    .filter((t) => t?.visible)
    .slice(-6);
  const cashBad = ch.res.cash < 0 || ch.res.debt > ch.res.cash + ch.res.realEstate;
  return (
    <header className="hud">
      <div className="hud-top">
        <button type="button" className="who" onClick={() => openSheet('profile')} aria-label="내 정보 보기">
          <strong>
            {ch.surname}
            {ch.given}
          </strong>
          <span>
            {ch.sex === 'M' ? '남' : '여'} · {REGION_BY_ID.get(ch.region)?.short} · {role}
          </span>
        </button>
        <div className="when">
          <span className="year num">{game.year}</span>
          <span className="age">만 {ch.age}세</span>
        </div>
      </div>
      <div className="stats">
        {STAT_KEYS.map((k) => (
          <div className="stat" key={k}>
            <span className="stat-name">{STAT_LABEL[k]}</span>
            <span className="bar" aria-hidden="true">
              <span className={`fill${ch.stats[k] < 25 ? ' low' : ''}`} style={{ width: `${Math.max(0, Math.min(100, ch.stats[k]))}%` }} />
            </span>
            <span className="stat-num num">{Math.round(ch.stats[k])}</span>
          </div>
        ))}
      </div>
      <div className="chips">
        <span className={`chip money${cashBad ? ' bad' : ''}`}>
          현금 <b className="num">{formatWonShort(ch.res.cash)}</b>
        </span>
        <span className={`chip${ch.state.stress >= 70 ? ' bad' : ''}`}>
          스트레스 <b className="num">{Math.round(ch.state.stress)}</b>
        </span>
        <span className="chip">
          평판 <b className="num">{Math.round(ch.state.reputation)}</b>
        </span>
        {tags.map((t) => (
          <span key={t!.id} className={`chip tag ${t!.sign ?? 'info'}`} title={t!.desc}>
            {t!.name}
          </span>
        ))}
      </div>
    </header>
  );
}

// ── 인생 로그: 연도별 일기 + 뉴스 ────────────────────────

interface YearGroup {
  year: number;
  age: number;
  entries: LogEntry[];
}

function groupByYear(log: LogEntry[]): YearGroup[] {
  const groups: YearGroup[] = [];
  for (const e of log) {
    const last = groups[groups.length - 1];
    if (last && last.year === e.year) last.entries.push(e);
    else groups.push({ year: e.year, age: e.age, entries: [e] });
  }
  return groups;
}

const PAGE = 12;

function LifeLog({ game }: { game: GameState }) {
  const groups = useMemo(() => groupByYear(game.log), [game.log]);
  const [shown, setShown] = useState(PAGE);
  const end = useRef<HTMLDivElement>(null);
  const count = game.log.length;
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [count]);
  const hidden = Math.max(0, groups.length - shown);
  const visible = groups.slice(hidden);
  return (
    <main className="log" aria-label="인생 기록">
      {hidden > 0 && (
        <button type="button" className="more" onClick={() => setShown((n) => n + PAGE)}>
          이전 {Math.min(PAGE, hidden)}년 더 보기
        </button>
      )}
      {visible.map((g) => (
        <section className="year-block" key={g.year}>
          <h3 className="year-head">
            <span className="num">{g.year}</span>
            <span>{g.entries[0].age}세</span>
          </h3>
          {g.entries.map((e, i) => (
            <Entry key={i} e={e} />
          ))}
        </section>
      ))}
      <div ref={end} className="log-end" />
    </main>
  );
}

function Entry({ e }: { e: LogEntry }) {
  if (e.kind === 'news') {
    return (
      <p className="entry news">
        <span className="kicker">뉴스</span>
        {e.text}
      </p>
    );
  }
  if (e.kind === 'year' || e.kind === 'system') return <p className="entry quiet">{e.text}</p>;
  return (
    <article className={`entry story tone-${e.tone ?? 'neutral'}${(e.impact ?? 0) >= 30 ? ' big' : ''} kind-${e.kind}`}>
      {e.title && <h4>{e.title}</h4>}
      <p>{e.text}</p>
    </article>
  );
}

// ── 변화 목록 (사건 카드·시트 공용) ─────────────────────

export function Changes({ list }: { list: { text: string; sign: string }[] }) {
  return (
    <ul className="changes">
      {list.map((c, i) => (
        <li key={i} className={c.sign}>
          {c.text}
        </li>
      ))}
    </ul>
  );
}

// ── 하단 탭 ──────────────────────────────────────────────

const TABS: { id: Sheet; label: string; icon: () => JSX.Element }[] = [
  { id: 'activity', label: '활동', icon: IconActivity },
  { id: 'relations', label: '관계', icon: IconPeople },
  { id: 'assets', label: '자산', icon: IconWon },
  { id: 'career', label: '학업·직업', icon: IconBook },
];

function TabBar({ game }: { game: GameState }) {
  const act = useGame((s) => s.act);
  const openSheet = useGame((s) => s.openSheet);
  const left = game.points.left;
  const busy = game.phase !== 'action';
  return (
    <nav className="tabbar" aria-label="행동">
      <button
        type="button"
        className="tab next"
        disabled={busy}
        onClick={() => act(endTurn)}
      >
        <IconYear />
        <span>+1년</span>
      </button>
      {TABS.map((t) => (
        <button key={t.id} type="button" className="tab" disabled={busy} onClick={() => openSheet(t.id)}>
          <t.icon />
          <span>{t.label}</span>
          {t.id === 'activity' && left > 0 && <i className="badge num">{left}</i>}
        </button>
      ))}
    </nav>
  );
}
