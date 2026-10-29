import { useEffect, useRef } from 'react';
import { choose, proceed } from '../engine/game';
import type { ActiveCard, GameState } from '../engine/types';
import { Changes } from './GameScreen';
import { circled } from './labels';
import { useGame } from './store';

const ARC_LABEL: Record<string, string> = {
  school_violence: '학교폭력',
  military_abuse: '군대 부조리',
  voice_phishing: '보이스피싱',
  scam_compound: '해외 범죄단지',
  politics: '정치',
  cult: '사이비',
  entertainment: '연예계',
  gambling: '도박',
  war: '전쟁',
};

const TONE_LABEL: Record<string, string> = {
  tragedy: '비극',
  drama: '사건',
  positive: '좋은 일',
  neutral: '일상',
  recovery: '회복',
};

export function EventCard({ game, card }: { game: GameState; card: ActiveCard }) {
  const act = useGame((s) => s.act);
  const done = card.choices.length === 0 || !!card.result;
  const firstButton = useRef<HTMLButtonElement>(null);

  // 카드가 바뀌면 첫 버튼에 초점 (키보드·화면낭독기)
  useEffect(() => {
    firstButton.current?.focus();
  }, [card.serial, done]);

  // 숫자 키로 고르고 Enter로 넘긴다
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!done) {
        const n = Number(e.key);
        if (n >= 1 && n <= card.choices.length) {
          e.preventDefault();
          act((s) => choose(s, n - 1));
        }
      } else if (e.key === 'Enter' || e.key === ' ') {
        if (document.activeElement?.tagName === 'BUTTON') return;
        e.preventDefault();
        act(proceed);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [act, card.choices.length, done]);

  const result = card.result;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="card-title">
      <article className={`card tone-${card.tone}`} key={card.serial}>
        <header className="card-date">
          <span className="card-year num">{game.year}</span>
          <span className="card-age">만 {game.ch.age}세</span>
          <span className="card-kind">{card.arcLabel ? ARC_LABEL[card.arcLabel] ?? card.arcLabel : TONE_LABEL[card.tone]}</span>
        </header>
        {card.zoom && <p className="zoom">{card.zoom}</p>}
        <h2 id="card-title" className="card-title">
          {card.title}
        </h2>
        <p className="card-text">{card.text}</p>
        {card.intro.length > 0 && <Changes list={card.intro} />}

        {!result && card.choices.length > 0 && (
          <ol className="choices">
            {card.choices.map((c, i) => (
              <li key={c.index}>
                <button ref={i === 0 ? firstButton : undefined} type="button" className="choice" onClick={() => act((s) => choose(s, i))}>
                  <span className="choice-no" aria-hidden="true">
                    {circled(i)}
                  </span>
                  <span className="choice-text">{c.text}</span>
                  {c.check && <span className="choice-check">{c.check} 판정</span>}
                </button>
              </li>
            ))}
          </ol>
        )}

        {result && (
          <section className="result" aria-live="polite">
            <p className="picked">
              <span aria-hidden="true">→ </span>
              {result.choice}
            </p>
            {result.success !== undefined && (
              <span className={`stamp ${result.success ? 'pass' : 'fail'}`}>{result.success ? '성공' : '실패'}</span>
            )}
            {result.text && <p className="result-text">{result.text}</p>}
            {result.changes.length > 0 && <Changes list={result.changes} />}
          </section>
        )}

        {done && (
          <button ref={firstButton} type="button" className="btn primary wide next-card" onClick={() => act(proceed)}>
            {game.ch.alive ? '계속' : '마지막 장 넘기기'}
          </button>
        )}
      </article>
    </div>
  );
}
