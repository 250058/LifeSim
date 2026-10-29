import { useState } from 'react';
import { normalizeSeed } from '../engine/rng';
import type { Mode } from '../engine/types';
import { MODE_INFO } from './labels';
import { DEFAULT_MODE, useGame } from './store';

const TITLE_ROWS = [
  ['대', '한', '민', '국', '에', '서'],
  ['태', '어', '났', '다', '', ''],
];

const MODES: Mode[] = ['reality', 'drama', 'makjang'];

export function TitleScreen() {
  const { game, graves, adult, setAdult, start, resume } = useGame();
  // 새 인생은 현실 모드에서 시작한다. 드라마·막장은 눌러서 고른다
  const [mode, setMode] = useState<Mode>(DEFAULT_MODE);
  const [seed, setSeed] = useState('');
  // 살던 인생이 있으면 한 번 더 눌러야 새로 태어난다 (저장이 하나뿐이다)
  const [confirming, setConfirming] = useState(false);
  const living = game && game.phase !== 'dead' ? game : null;
  const born = () => {
    if (living && !confirming) {
      setConfirming(true);
      return;
    }
    start({ seed: normalizeSeed(seed), mode });
  };

  return (
    <main className="title page">
      <h1 className="manuscript" aria-label="대한민국에서 태어났다">
        {TITLE_ROWS.map((row, r) => (
          <span className="manuscript-row" key={r} aria-hidden="true">
            {row.map((c, i) => (
              <span className="cell" key={i}>
                {c}
                {r === 1 && i === 5 && <span className="seal">生</span>}
              </span>
            ))}
          </span>
        ))}
      </h1>
      <p className="pitch">버튼 한 번에 대한민국 어딘가에서 태어나, 한 해씩 살다가 죽는다. 무슨 일이 생길지는 아무도 모른다.</p>

      <section className="gate" aria-labelledby="gate-title">
        <div className="rating" aria-hidden="true">
          19
        </div>
        <div className="gate-body">
          <h2 id="gate-title">청소년이용불가</h2>
          <p>학교폭력, 군대 가혹행위, 범죄, 전쟁, 죽음을 다룬다. 범죄 수법은 나오지 않는다.</p>
          <label className="check">
            <input id="adult-check" type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
            <span>만 19세 이상이다</span>
          </label>
        </div>
      </section>

      {living && (
        <button className="btn primary wide" type="button" onClick={resume} disabled={!adult}>
          이어 살기
          <small>
            {living.ch.surname}
            {living.ch.given} · {living.ch.age}세 · {living.year}년
          </small>
        </button>
      )}

      <section className="new-life" aria-labelledby="new-title">
        <h2 id="new-title" className="label">새 인생</h2>
        <div className="modes" role="radiogroup" aria-label="모드">
          {MODES.map((m) => (
            <button
              key={m}
              id={`mode-${m}`}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={`mode${mode === m ? ' on' : ''}`}
              onClick={() => setMode(m)}
            >
              <strong>{MODE_INFO[m].label}</strong>
              <span>{MODE_INFO[m].desc}</span>
            </button>
          ))}
        </div>
        <label className="field" htmlFor="seed-input">
          <span>시드</span>
          <input
            id="seed-input"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder="비우면 무작위. 같은 시드면 같은 인생"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button className={`btn ${living && !confirming ? '' : 'primary'} wide`} type="button" disabled={!adult} onClick={born}>
          {confirming ? '그래도 새로 태어나기' : '태어나기'}
        </button>
        {confirming && living && (
          <p className="hint warn" role="alert">
            {living.ch.surname}
            {living.ch.given}({living.ch.age}세)의 인생은 사라진다.
          </p>
        )}
        {!adult && <p className="hint">만 19세 이상임을 확인해야 시작할 수 있다.</p>}
      </section>

      {graves.length > 0 && (
        <section className="graves" aria-labelledby="graves-title">
          <h2 id="graves-title" className="label">지난 인생</h2>
          <ol>
            {graves.slice(0, 6).map((g) => (
              <li key={`${g.seed}-${g.deathYear}-${g.name}`}>
                <div className="grave-head">
                  <strong>{g.name}</strong>
                  <span className="num">
                    {g.birthYear}–{g.deathYear} · {g.age}세
                  </span>
                </div>
                <p>“{g.epitaph}”</p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <footer className="foot">
        등장하는 사람·정당·대학·회사 이름은 모두 지어낸 것이다.
        <br />
        힘들 때는 자살예방상담 109, 청소년상담 1388.
      </footer>
    </main>
  );
}
