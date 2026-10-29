import { formatWon, josa } from '../engine/format';
import { heirOptions } from '../engine/heir';
import type { GameState } from '../engine/types';
import { MODE_INFO } from './labels';
import { Seed } from './Sheets';
import { abandonLife, useGame } from './store';

export function DeathScreen({ game }: { game: GameState }) {
  const s = game.summary!;
  const start = useGame((st) => st.start);
  const continueAs = useGame((st) => st.continueAs);
  const graves = useGame((st) => st.graves);
  const heirs = heirOptions(game);
  const lineage = game.lineage;
  const lifeNo = graves.length;
  return (
    <main className="death page">
      <section className="stone" aria-label="묘비">
        <p className="stone-kicker">故</p>
        <h1 className="stone-name">{s.name}</h1>
        <p className="stone-years num">
          {s.birthYear} – {s.deathYear}
        </p>
        <p className="stone-epitaph">{s.epitaph}</p>
      </section>

      <p className="death-line">
        {s.region}에서 태어나 만 {s.age}세에 {josa(s.cause, '으로/로')} 세상을 떠났다.
      </p>

      <dl className="ledger summary">
        <div>
          <dt>학력</dt>
          <dd>{s.degree}</dd>
        </div>
        <div>
          <dt>마지막 직업</dt>
          <dd>{s.job ?? '없음'}</dd>
        </div>
        <div>
          <dt>가족</dt>
          <dd>
            {s.spouse ? `배우자 ${s.spouse}` : '배우자 없음'} · 자녀 {s.children}명
          </dd>
        </div>
        <div>
          <dt>남긴 재산</dt>
          <dd className="num">{formatWon(Math.round(s.netWorth / 10_000) * 10_000)}</dd>
        </div>
      </dl>

      {s.achievements.length > 0 && (
        <section className="group">
          <h2 className="label">업적</h2>
          <ul className="badges">
            {s.achievements.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="group">
        <h2 className="label">인생 연표</h2>
        <ol className="timeline">
          {s.highlights.map((h, i) => (
            <li key={i} className={`tone-${h.tone ?? 'neutral'}`}>
              <span className="t-age num">{h.age}세</span>
              <div>
                {h.title && <strong>{h.title}</strong>}
                <p>{h.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {s.tags.length > 0 && (
        <section className="group">
          <h2 className="label">남은 태그</h2>
          <p className="plain">{s.tags.join(' · ')}</p>
        </section>
      )}

      <section className="group">
        <Seed
          seed={s.seed}
          label={
            lineage
              ? `${MODE_INFO[s.mode].label} 모드 · ${lineage.generation}대째 · 시드`
              : `${MODE_INFO[s.mode].label} 모드 · 시드 (같은 시드면 같은 인생)`
          }
        />
      </section>

      {heirs.length > 0 && (
        <section className="group">
          <h2 className="label">자녀로 이어 살기</h2>
          <p className="plain">같은 세상, 같은 해에서 자녀의 나이로 이어 산다. 재산은 상속세를 떼고 나눠 받는다.</p>
          <div className="end-actions">
            {heirs.map((h) => (
              <button key={h.npc.id} type="button" className="btn wide" onClick={() => continueAs(h.npc.id)}>
                {h.npc.name}
                <small>
                  {h.label} · {h.age}세
                </small>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="end-actions">
        <button type="button" className="btn primary wide" onClick={() => start({ seed: null, mode: s.mode })}>
          새 인생
        </button>
        {!lineage && (
          <button type="button" className="btn wide" onClick={() => start({ seed: s.seed, mode: s.mode, birthYear: s.birthYear })}>
            같은 시드로 다시 태어나기
          </button>
        )}
        <button type="button" className="btn wide ghost" onClick={abandonLife}>
          제목 화면
        </button>
      </div>
      {lifeNo > 1 && <p className="foot">지금까지 {lifeNo}번 살았다.</p>}
    </main>
  );
}
