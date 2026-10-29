// 하단 탭이 여는 시트: 활동, 관계, 자산, 학업·직업, 내 정보

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { activityViews } from '../engine/activities';
import { csatSummary, jobOpenings, jobSalary, DEGREE_LABEL, TIER_LABEL } from '../engine/career';
import { REGION_BY_ID, TAG_BY_ID } from '../engine/data';
import { formatWon, formatWonShort, HIGH_TYPE_LABEL } from '../engine/format';
import {
  applyForJob,
  buyHome,
  buyStocks,
  doActivity,
  homePrice,
  prepareCsat,
  quitJob,
  repayDebt,
  sellHome,
  sellStocks,
  spendTime,
  type ActionResult,
} from '../engine/game';
import { npcAge, roleLabel } from '../engine/relations';
import { annualIncome, inPrison, netWorth } from '../engine/scope';
import { TALENT_LABEL } from '../engine/text';
import { PERSONALITY_KEYS, type GameState, type Npc, type PersonalityKey } from '../engine/types';
import { Changes } from './GameScreen';
import { IconClose } from './icons';
import { ECONOMY_LABEL, GROUP_LABEL, MODE_INFO, SCHOOL_LABEL } from './labels';
import { useGame, type Sheet } from './store';

const TITLES: Record<Sheet, string> = {
  activity: '올해 할 일',
  relations: '관계',
  assets: '자산',
  career: '학업·직업',
  profile: '내 정보',
};

export function SheetHost({ game, sheet }: { game: GameState; sheet: Sheet }) {
  const close = useGame((s) => s.openSheet);
  const notice = useGame((s) => s.notice);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  return (
    <div className="overlay sheet-overlay" role="dialog" aria-modal="true" aria-labelledby="sheet-title" onClick={() => close(null)}>
      <section className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2 id="sheet-title">{TITLES[sheet]}</h2>
          {sheet === 'activity' && <Points game={game} />}
          <button ref={closeButton} type="button" className="icon-btn" onClick={() => close(null)} aria-label="닫기">
            <IconClose />
          </button>
        </header>
        {notice && (
          <div className={`receipt${notice.ok === false ? ' fail' : ''}`} role="status" key={notice.id}>
            <p>{notice.text}</p>
            {notice.changes && notice.changes.length > 0 && <Changes list={notice.changes} />}
          </div>
        )}
        <div className="sheet-body">
          {sheet === 'activity' && <ActivitySheet game={game} />}
          {sheet === 'relations' && <RelationsSheet game={game} />}
          {sheet === 'assets' && <AssetsSheet game={game} />}
          {sheet === 'career' && <CareerSheet game={game} />}
          {sheet === 'profile' && <ProfileSheet game={game} />}
        </div>
      </section>
    </div>
  );
}

function Points({ game }: { game: GameState }) {
  const { max, left } = game.points;
  return (
    <span className="points" aria-label={`남은 시간 ${left} / ${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <i key={i} className={i < left ? 'on' : ''} />
      ))}
    </span>
  );
}

/** 엔진 행동을 실행하고 결과를 알림으로 */
function useRun() {
  const act = useGame((s) => s.act);
  const notify = useGame((s) => s.notify);
  return (fn: (s: GameState) => ActionResult) => {
    const r = act(fn);
    if (r) notify({ text: r.text, changes: r.changes, ok: r.ok });
  };
}

// ── 활동 ────────────────────────────────────────────────

const GROUP_ORDER = ['growth', 'social', 'life', 'money', 'risk'];

function ActivitySheet({ game }: { game: GameState }) {
  const act = useGame((s) => s.act);
  const notify = useGame((s) => s.notify);
  const close = useGame((s) => s.openSheet);
  const views = activityViews(game);
  const groups = GROUP_ORDER.map((g) => ({ g, items: views.filter((v) => v.def.group === g) })).filter((x) => x.items.length > 0);

  const run = (id: string) => {
    const r = act((s) => doActivity(s, id));
    if (!r) return;
    notify({ text: r.text, changes: r.changes, ok: true });
    // 체포처럼 카드가 생기면 시트를 닫고 카드를 보여 준다
    if (r.queuedCard) close(null);
  };

  return (
    <>
      <p className="sheet-note">
        시간은 해마다 다시 채워진다. 남은 시간이 있어도 <b>+1년</b>을 누르면 그냥 넘어간다.
      </p>
      {groups.map(({ g, items }) => (
        <section className="group" key={g}>
          <h3 className="label">{GROUP_LABEL[g] ?? g}</h3>
          <ul className="rows">
            {items.map((v) => (
              <li key={v.def.id}>
                <button type="button" className={`row-btn${v.def.group === 'risk' ? ' risky' : ''}`} disabled={!v.enabled} onClick={() => run(v.def.id)}>
                  <span className="row-main">
                    <strong>{v.def.name}</strong>
                    <span>{v.reason ?? v.def.desc}</span>
                  </span>
                  <span className="row-side num">
                    {v.cost > 0 && <span>{formatWonShort(v.cost)}</span>}
                    {game.actions[v.def.id] ? <span className="done">×{game.actions[v.def.id]}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

// ── 관계 ────────────────────────────────────────────────

const ROLE_ORDER: Npc['role'][] = ['spouse', 'partner', 'child', 'mother', 'father', 'grandparent', 'sibling', 'friend', 'ex'];

function RelationsSheet({ game }: { game: GameState }) {
  const run = useRun();
  const ch = game.ch;
  const sorted = [...ch.npcs].sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.birthYear - b.birthYear;
  });
  const canSpend = game.phase === 'action' && game.points.left > 0 && !inPrison(game);
  if (sorted.length === 0) return <p className="empty">곁에 아무도 없다.</p>;
  return (
    <ul className="people">
      {sorted.map((n) => (
        <li key={n.id} className={n.alive ? '' : 'gone'}>
          <div className="person">
            <span className="role">{roleLabel(n, ch)}</span>
            <strong>{n.name}</strong>
            <span className="num age-of">
              {n.alive ? `${npcAge(n, game.year)}세` : n.missing ? '생사 불명' : `${n.deathYear ?? ''}년 사망`}
            </span>
          </div>
          {n.alive && !n.missing ? (
            <div className="person-bottom">
              <span className="bar closeness" aria-label={`친밀도 ${Math.round(n.closeness)}`}>
                <span className="fill" style={{ width: `${n.closeness}%` }} />
              </span>
              <button type="button" className="btn small" disabled={!canSpend} onClick={() => run((s) => spendTime(s, n.id))}>
                시간 보내기
              </button>
            </div>
          ) : (
            n.deathCause && <p className="quiet">{n.deathCause}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── 자산 ────────────────────────────────────────────────

function AssetsSheet({ game }: { game: GameState }) {
  const run = useRun();
  const ch = game.ch;
  const r = ch.res;
  const e = game.world.economy;
  const minor = ch.age < 19;
  const price = homePrice(game);
  const busy = game.phase !== 'action';
  return (
    <>
      <div className="networth">
        <span className="label">순자산</span>
        <strong className="num">{formatWon(Math.round(netWorth(game) / 10_000) * 10_000)}</strong>
      </div>
      <dl className="ledger">
        <div>
          <dt>현금</dt>
          <dd className="num">{formatWon(Math.round(r.cash / 10_000) * 10_000)}</dd>
        </div>
        <div>
          <dt>주식·코인</dt>
          <dd className="num">{formatWon(Math.round((r.stocks + r.coins) / 10_000) * 10_000)}</dd>
        </div>
        <div>
          <dt>부동산</dt>
          <dd className="num">{formatWon(Math.round(r.realEstate / 10_000) * 10_000)}</dd>
        </div>
        <div className={r.debt > 0 ? 'bad' : ''}>
          <dt>빚</dt>
          <dd className="num">{formatWon(Math.round(r.debt / 10_000) * 10_000)}</dd>
        </div>
        <div>
          <dt>올해 소득 (세전)</dt>
          <dd className="num">{formatWon(Math.round(annualIncome(game) / 10_000) * 10_000)}</dd>
        </div>
      </dl>

      <section className="group">
        <h3 className="label">{game.year}년 경제</h3>
        <dl className="market">
          <div>
            <dt>경기</dt>
            <dd>{ECONOMY_LABEL[e.phase]}</dd>
          </div>
          <div>
            <dt>기준금리</dt>
            <dd className="num">{e.interest.toFixed(2)}%</dd>
          </div>
          <div>
            <dt>물가 (2026=100)</dt>
            <dd className="num">{Math.round(e.priceIndex * 100)}</dd>
          </div>
          <div>
            <dt>주가지수</dt>
            <dd className="num">{Math.round(e.stockIndex)}</dd>
          </div>
          <div>
            <dt>집값지수</dt>
            <dd className="num">{Math.round(e.housingIndex)}</dd>
          </div>
          <div>
            <dt>최저시급</dt>
            <dd className="num">{e.minWage.toLocaleString('ko-KR')}원</dd>
          </div>
        </dl>
      </section>

      {minor ? (
        <p className="sheet-note">만 19세가 되면 돈을 직접 굴릴 수 있다. 지금은 용돈과 알바비가 전부다.</p>
      ) : (
        <section className="group">
          <h3 className="label">돈 굴리기</h3>
          <div className="actions">
            <button type="button" className="btn" disabled={busy || r.cash < 100_000} onClick={() => run((s) => buyStocks(s, 0.3))}>
              주식 사기 <small>현금의 30%</small>
            </button>
            <button type="button" className="btn" disabled={busy || r.stocks + r.coins <= 0} onClick={() => run(sellStocks)}>
              주식 전부 팔기
            </button>
            <button type="button" className="btn" disabled={busy || r.debt <= 0 || r.cash <= 0} onClick={() => run(repayDebt)}>
              빚 갚기
            </button>
            {ch.flags.homeowner ? (
              <button type="button" className="btn" disabled={busy} onClick={() => run(sellHome)}>
                집 팔기 <small>{formatWonShort(r.realEstate)}</small>
              </button>
            ) : (
              <button type="button" className="btn" disabled={busy} onClick={() => run(buyHome)}>
                집 사기 <small>{REGION_BY_ID.get(ch.region)?.short} {formatWonShort(price)}</small>
              </button>
            )}
          </div>
          <p className="sheet-note">집은 값의 30% 이상 현금이 있어야 살 수 있고, 나머지는 주택담보대출이다.</p>
        </section>
      )}
    </>
  );
}

// ── 학업·직업 ───────────────────────────────────────────

function CareerSheet({ game }: { game: GameState }) {
  const run = useRun();
  const ch = game.ch;
  const edu = ch.edu;
  const c = ch.career;
  const busy = game.phase !== 'action';
  const canSeek = ch.age >= 19 && ch.military.status !== 'serving' && !inPrison(game) && !(edu.status === 'university' && !edu.onLeave && ch.age < 21);
  const openings = canSeek ? jobOpenings(game) : [];
  const canRetake = ch.age >= 18 && ch.age <= 25 && edu.status !== 'university' && !c.jobId && !ch.flags.retake && !!edu.csat;
  return (
    <>
      <section className="group">
        <h3 className="label">학교</h3>
        <dl className="ledger">
          <div>
            <dt>지금</dt>
            <dd>
              {SCHOOL_LABEL[edu.status]}
              {edu.highType && edu.status === 'high' ? ` · ${HIGH_TYPE_LABEL[edu.highType]}` : ''}
              {edu.status === 'university' && edu.univ ? ` · ${edu.univ.name}${edu.onLeave ? ' (휴학)' : ''}` : ''}
            </dd>
          </div>
          <div>
            <dt>최종 학력</dt>
            <dd>
              {DEGREE_LABEL[edu.degree]}
              {edu.univ && edu.status !== 'university' ? ` · ${edu.univ.name}` : ''}
            </dd>
          </div>
          {['elementary', 'middle', 'high'].includes(edu.status) && (
            <div>
              <dt>내신</dt>
              <dd className="num">상위 {Math.max(1, Math.round(100 - edu.grade))}%</dd>
            </div>
          )}
          {edu.highType && edu.status !== 'high' && (
            <div>
              <dt>고등학교</dt>
              <dd>{HIGH_TYPE_LABEL[edu.highType]}</dd>
            </div>
          )}
          {edu.csat && (
            <div>
              <dt>수능</dt>
              <dd>{csatSummary(game)}</dd>
            </div>
          )}
          {edu.earlyAdmit && (
            <div>
              <dt>수시 합격</dt>
              <dd>
                {edu.earlyAdmit.name} ({TIER_LABEL[edu.earlyAdmit.tier]})
              </dd>
            </div>
          )}
        </dl>
        {canRetake && (
          <div className="actions">
            <button type="button" className="btn" disabled={busy} onClick={() => run(prepareCsat)}>
              재수 학원 등록 <small>내년 수능 재응시</small>
            </button>
          </div>
        )}
      </section>

      {ch.sex === 'M' && ch.age >= 18 && (
        <section className="group">
          <h3 className="label">병역</h3>
          <p className="plain">{militaryText(game)}</p>
        </section>
      )}

      <section className="group">
        <h3 className="label">일</h3>
        {c.jobId ? (
          <dl className="ledger">
            <div>
              <dt>직업</dt>
              <dd>{c.title}</dd>
            </div>
            <div>
              <dt>연봉</dt>
              <dd className="num">{formatWon(Math.round(c.salary / 10_000) * 10_000)}</dd>
            </div>
            <div>
              <dt>근속</dt>
              <dd className="num">{c.years}년</dd>
            </div>
          </dl>
        ) : (
          <p className="plain">{ch.age < 15 ? '아직 일할 나이가 아니다.' : c.retired ? '은퇴했다.' : '지금은 일이 없다.'}</p>
        )}
        {c.jobId && !c.business && (
          <div className="actions">
            <button type="button" className="btn" disabled={busy} onClick={() => run(quitJob)}>
              사표 내기
            </button>
          </div>
        )}
        {c.history.length > 1 && (
          <p className="quiet">
            지난 일: {c.history.slice(0, -1).map((h) => h.title).join(' → ')}
          </p>
        )}
      </section>

      {canSeek && (
        <section className="group">
          <h3 className="label">올해 채용 공고</h3>
          {openings.length === 0 ? (
            <p className="plain">조건에 맞는 공고가 없다.</p>
          ) : (
            <ul className="rows">
              {openings.map(({ job, chance }) => {
                const applied = c.appliedThisYear.includes(job.id);
                return (
                  <li key={job.id}>
                    <button type="button" className="row-btn" disabled={busy || applied} onClick={() => run((s) => applyForJob(s, job.id))}>
                      <span className="row-main">
                        <strong>{job.title}</strong>
                        <span>
                          초봉 {formatWonShort(jobSalary(job, 0, game.world.economy.priceIndex, 1))} · {job.desc ?? job.category}
                        </span>
                      </span>
                      <span className="row-side num">{applied ? <span className="done">지원함</span> : <span>합격 {Math.round(chance * 100)}%</span>}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

function militaryText(game: GameState): string {
  const m = game.ch.military;
  const branch = { army: '육군', navy: '해군', airforce: '공군', marines: '해병대', social: '사회복무요원' }[m.branch ?? 'army'];
  switch (m.status) {
    case 'pending':
      return m.grade ? `신체등급 ${m.grade}급. 입영 대기 중.` : '병역판정검사를 기다린다.';
    case 'serving':
      return `${branch} 복무 중.`;
    case 'done':
      return `${branch} 만기 전역.`;
    case 'exempt':
      return '병역 면제.';
    default:
      return '아직 병역 대상이 아니다.';
  }
}

// ── 내 정보 ─────────────────────────────────────────────

const PERSONALITY_LABEL: Record<PersonalityKey, [string, string]> = {
  extraversion: ['내향', '외향'],
  conscientiousness: ['즉흥', '성실'],
  openness: ['보수', '개방'],
  agreeableness: ['경쟁', '우호'],
  neuroticism: ['느긋', '예민'],
};

const FAMILY_LABEL: Record<string, string> = {
  two_parent: '양부모',
  single_parent: '한부모',
  grandparents: '조부모',
  facility: '보육원',
};

const TRAIT_LABEL: Record<string, string> = {
  twin: '쌍둥이',
  genius: '천재',
  congenital_heart: '선천성 심장질환',
  perfect_pitch: '절대음감',
};

function talentText(talents: GameState['ch']['talents']): string {
  if (talents.length === 0) return '특별한 재능은 없는 것 같다.';
  const found = talents.filter((t) => t.discovered).map((t) => TALENT_LABEL[t.key]);
  const hidden = talents.length - found.length;
  const parts = [...found];
  if (hidden > 0) parts.push(`아직 모르는 재능 ${hidden}개 (활동을 해 봐야 드러난다)`);
  return parts.join(', ');
}

function ProfileSheet({ game }: { game: GameState }) {
  const toTitle = useGame((s) => s.toTitle);
  const ch = game.ch;
  const tags = Object.keys(ch.flags)
    .map((id) => TAG_BY_ID.get(id))
    .filter((t) => t?.visible);
  const wealth = ch.family.wealth === 6 ? '재벌가' : `소득 ${ch.family.wealth}분위`;
  return (
    <>
      <dl className="ledger">
        <div>
          <dt>태어난 곳</dt>
          <dd>
            {game.startYear}년 {REGION_BY_ID.get(ch.birthRegion)?.name}
          </dd>
        </div>
        <div>
          <dt>사는 곳</dt>
          <dd>{REGION_BY_ID.get(ch.region)?.name}</dd>
        </div>
        <div>
          <dt>집안</dt>
          <dd>
            {FAMILY_LABEL[ch.family.type]} · {wealth}
          </dd>
        </div>
        {game.lineage && (
          <div>
            <dt>이어 사는 인생</dt>
            <dd>
              {game.lineage.generation}대째 · {game.lineage.parentName}의 자녀
            </dd>
          </div>
        )}
        {ch.traits.length > 0 && (
          <div>
            <dt>타고난 것</dt>
            <dd>{ch.traits.map((t) => TRAIT_LABEL[t] ?? t).join(', ')}</dd>
          </div>
        )}
      </dl>

      <section className="group">
        <h3 className="label">성격</h3>
        <ul className="traits">
          {PERSONALITY_KEYS.map((k) => (
            <li key={k}>
              <span>{PERSONALITY_LABEL[k][0]}</span>
              <span className="scale" aria-label={`${PERSONALITY_LABEL[k][1]} ${Math.round(ch.personality[k])}`}>
                <i style={{ left: `${Math.max(0, Math.min(100, ch.personality[k]))}%` }} />
              </span>
              <span>{PERSONALITY_LABEL[k][1]}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="group">
        <h3 className="label">재능</h3>
        <p className="plain">
          {talentText(ch.talents)}
        </p>
      </section>

      {tags.length > 0 && (
        <section className="group">
          <h3 className="label">특성 태그</h3>
          <ul className="tag-list">
            {tags.map((t) => (
              <li key={t!.id} className={t!.sign ?? 'info'}>
                <strong>{t!.name}</strong>
                {t!.desc && <span>{t!.desc}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="group">
        <h3 className="label">이 인생</h3>
        <Seed seed={game.seed} label={`${MODE_INFO[game.mode].label} 모드 · 시드`} />
        <div className="actions">
          <button type="button" className="btn" onClick={toTitle}>
            제목 화면으로 <small>진행은 저장된다</small>
          </button>
        </div>
      </section>
    </>
  );
}

/** 시드 보기·복사. 클립보드를 못 쓰면 글자를 선택해 둔다 */
export function Seed({ seed, label }: { seed: string; label: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  const code = useRef<HTMLElement>(null);
  const copy = () => {
    const select = () => {
      const el = code.current;
      const sel = window.getSelection();
      if (el && sel) sel.selectAllChildren(el);
    };
    try {
      navigator.clipboard.writeText(seed).then(() => setCopied(true), select);
    } catch {
      select();
    }
  };
  return (
    <div className="seed">
      <span className="label">{label}</span>
      <code ref={code} className="num">
        {seed}
      </code>
      <button type="button" className="btn small" onClick={copy}>
        {copied ? '복사함' : '복사'}
      </button>
    </div>
  );
}
