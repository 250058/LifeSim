// 학업·직업 시트의 '일' 부분: 지금 일과 부업, 소득 기록, 올해 공고, 직업 찾아보기(분야·검색·지원 조건),
// 자격·면허 공부, 직업훈련. 직업이 수백 개라 찾아보기는 분야와 검색어로 좁히고 조금씩 펼친다.

import { useMemo, useState } from 'react';
import { jobOpenings, jobSalary } from '../engine/career';
import { JOBS, JOB_BY_ID } from '../engine/data';
import { formatWon, formatWonShort } from '../engine/format';
import { applyForJob, quitJob, type ActionResult } from '../engine/game';
import { buildScope } from '../engine/scope';
import type { JobDef } from '../engine/schema';
import type { EmploymentType, GameState } from '../engine/types';
import {
  currentHours,
  currentType,
  FIELD_BY_ID,
  JOB_FIELDS,
  JOB_SOURCES,
  jobRequirements,
  ledgerOf,
  LICENSES,
  licenseBlock,
  licensePassChance,
  quitSideJob,
  SCHEDULE_LABEL,
  sideJobBlock,
  startTraining,
  studyLicense,
  takeSideJob,
  TRAINING_TRACKS,
  TYPE_LABEL,
} from '../engine/work';
import { useGame } from './store';

/** 엔진 행동을 실행하고 결과를 알림으로 (Sheets.tsx와 같은 방식) */
function useRun() {
  const act = useGame((s) => s.act);
  const notify = useGame((s) => s.notify);
  return (fn: (s: GameState) => ActionResult) => {
    const r = act(fn);
    if (r) notify({ text: r.text, changes: r.changes, ok: r.ok });
  };
}

const INJURY_LABEL = ['산재 위험 낮음', '산재 위험 조금', '산재 위험 보통', '산재 위험 높음', '산재 위험 매우 높음'];

function typesOf(job: JobDef): string {
  return Object.keys(job.employment ?? { regular: 1 })
    .map((t) => TYPE_LABEL[t as EmploymentType])
    .join('·');
}

function scheduleOf(job: JobDef): string {
  return (job.schedule ?? []).map((s) => SCHEDULE_LABEL[s]).join('·');
}

/** 연봉 범위: [초봉, 25년 차] (2026년 원 × 지금 물가) */
function salaryRange(job: JobDef, pi: number): string {
  const lo = jobSalary(job, 0, pi, 1);
  const hi = jobSalary(job, 25, pi, 1);
  return lo === hi ? formatWonShort(lo) : `${formatWonShort(lo)}~${formatWonShort(hi)}`;
}

// ── 지금 하는 일 ─────────────────────────────────────────

export function WorkNow({ game }: { game: GameState }) {
  const run = useRun();
  const ch = game.ch;
  const c = ch.career;
  const w = c.work;
  const busy = game.phase !== 'action';
  const job = c.jobId ? JOB_BY_ID.get(c.jobId) : undefined;
  const type = currentType(game);
  const pi = game.world.economy.priceIndex;
  const side = w?.side ? JOB_BY_ID.get(w.side.jobId) : undefined;
  return (
    <>
      {c.jobId ? (
        <dl className="ledger">
          <div>
            <dt>직업</dt>
            <dd>
              {c.title}
              {type ? ` · ${TYPE_LABEL[type]}` : ''}
            </dd>
          </div>
          <div>
            <dt>연봉</dt>
            <dd className="num">{formatWon(Math.round(c.salary / 10_000) * 10_000)}</dd>
          </div>
          <div>
            <dt>근속</dt>
            <dd className="num">{c.years}년</dd>
          </div>
          {job && !c.business && (
            <div>
              <dt>근무</dt>
              <dd>
                주 {currentHours(game)}시간{scheduleOf(job) ? ` · ${scheduleOf(job)}` : ''}
              </dd>
            </div>
          )}
          {w?.contractUntil !== undefined && (
            <div className={w.ending ? 'bad' : undefined}>
              <dt>계약</dt>
              <dd>{w.ending ? '재계약하지 않는다는 통보를 받았다' : `${w.contractUntil}세 생일까지 (갱신 ${w.renewals ?? 0}번)`}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="plain">{ch.age < 15 ? '아직 일할 나이가 아니다.' : c.retired ? '은퇴했다.' : '지금은 일이 없다.'}</p>
      )}
      {(side || w?.arrears || (w?.injury && ch.age - w.injury.age <= 1)) && (
        <dl className="ledger">
          {side && w?.side && (
            <div>
              <dt>부업</dt>
              <dd>
                {side.title} · {TYPE_LABEL[w.side.type]} · 주 {w.side.hours}시간
              </dd>
            </div>
          )}
          {w?.arrears && (
            <div className="bad">
              <dt>체불</dt>
              <dd className="num">{formatWon(Math.round((w.arrears.amount * pi) / 10_000) * 10_000)}</dd>
            </div>
          )}
          {w?.injury && ch.age - w.injury.age <= 1 && (
            <div className="bad">
              <dt>부상</dt>
              <dd>{w.injury.cover === 'claim' ? '산재 요양' : w.injury.cover === 'company' ? '공상 처리' : '자비 치료'} · {Math.round(w.injury.months)}개월 쉼</dd>
            </div>
          )}
        </dl>
      )}
      {((c.jobId && !c.business) || side) && (
        <div className="actions">
          {c.jobId && !c.business && (
            <button type="button" className="btn" disabled={busy} onClick={() => run(quitJob)}>
              사표 내기
            </button>
          )}
          {side && (
            <button type="button" className="btn" disabled={busy} onClick={() => run(quitSideJob)}>
              부업 그만두기
            </button>
          )}
        </div>
      )}
      <IncomeLedger game={game} />
      {c.history.length > 1 && <p className="quiet">지난 일: {c.history.slice(0, -1).map((h) => h.title).join(' → ')}</p>}
    </>
  );
}

/** 최근 다섯 해의 소득 원장 (2026년 원) */
function IncomeLedger({ game }: { game: GameState }) {
  const rows = ledgerOf(game.ch).slice(-5).reverse();
  if (rows.length === 0) return null;
  return (
    <p className="quiet">
      소득 기록 (2026년 원):{' '}
      {rows
        .map((y) => {
          const job = y.jobId ? JOB_BY_ID.get(y.jobId)?.title ?? '사업' : '실직';
          const parts = [`${y.age}세 ${job}${y.type ? `(${TYPE_LABEL[y.type]})` : ''} ${formatWonShort(y.gross)}`];
          if (y.days) parts.push(`${y.days}일 일함`);
          if (y.side) parts.push(`부업 ${formatWonShort(y.side)}`);
          if (y.benefit) parts.push(`급여·회수 ${formatWonShort(y.benefit)}`);
          return parts.join(' · ');
        })
        .join(' / ')}
    </p>
  );
}

// ── 올해 공고 ─────────────────────────────────────────────

export function Openings({ game }: { game: GameState }) {
  const run = useRun();
  const c = game.ch.career;
  const busy = game.phase !== 'action';
  const openings = jobOpenings(game);
  return (
    <section className="group">
      <h3 className="label">올해 채용 공고</h3>
      {openings.length === 0 ? (
        <p className="plain">조건에 맞는 공고가 없다.</p>
      ) : (
        <ul className="rows">
          {openings.map(({ job, chance, offer, via }) => {
            const applied = c.appliedThisYear.includes(job.id);
            const tag = via === 'referral' ? '지인 추천 · ' : via === 'return' ? '경력 복귀 · ' : '';
            return (
              <li key={job.id}>
                <button type="button" className="row-btn" disabled={busy || applied} onClick={() => run((s) => applyForJob(s, job.id))}>
                  <span className="row-main">
                    <strong>{job.title}</strong>
                    <span>
                      {tag}
                      {offer ? `${TYPE_LABEL[offer.type]} · 주 ${offer.hours}시간 · 첫해 ${formatWonShort(offer.salary)}` : job.desc}
                      {offer && offer.capital > 0 ? ` · 개업 자금 ${formatWonShort(offer.capital)}` : ''}
                    </span>
                  </span>
                  <span className="row-side num">{applied ? <span className="done">지원함</span> : <span>합격 {Math.round(chance * 100)}%</span>}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="sheet-note">공고는 학력·경력에 맞춰 찾아본 결과다. 다른 일은 아래 ‘직업 찾아보기’에서 시간 한 칸을 들여 직접 지원할 수 있다.</p>
    </section>
  );
}

// ── 직업 찾아보기 ─────────────────────────────────────────

const PAGE = 20;

export function JobBrowser({ game }: { game: GameState }) {
  const run = useRun();
  const [query, setQuery] = useState('');
  const [field, setField] = useState('all');
  const [onlyOk, setOnlyOk] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const busy = game.phase !== 'action';
  const pi = game.world.economy.priceIndex;
  const listed = useMemo(() => JOBS.filter((j) => j.listed), []);
  const matched = useMemo(() => {
    const scope = buildScope(game);
    const q = query.trim();
    return listed
      .filter((j) => field === 'all' || j.field === field)
      .filter((j) => !q || `${j.title} ${j.desc ?? ''} ${FIELD_BY_ID.get(j.field ?? '')?.label ?? ''}`.includes(q))
      .map((job) => ({ job, reqs: jobRequirements(game, job, scope) }))
      .filter(({ reqs }) => !onlyOk || reqs.every((r) => r.ok));
  }, [game, listed, field, query, onlyOk]);

  const pick = (id: string) => {
    setField(id);
    setLimit(PAGE);
  };
  return (
    <section className="group">
      <h3 className="label">직업 찾아보기 · {listed.length}개</h3>
      <label className="field">
        <span>검색</span>
        <input
          type="search"
          value={query}
          placeholder="예: 간호, 운전, 용접, 플랫폼"
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(PAGE);
          }}
        />
      </label>
      <div className="chips" role="group" aria-label="분야">
        {[{ id: 'all', label: '전체' }, ...JOB_FIELDS].map((f) => (
          <button
            key={f.id}
            type="button"
            className="chip"
            aria-pressed={field === f.id}
            style={field === f.id ? { borderColor: 'var(--accent)', color: 'var(--accent)', fontWeight: 600 } : undefined}
            onClick={() => pick(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={onlyOk} onChange={(e) => setOnlyOk(e.target.checked)} />
        <span>지금 조건을 갖춘 일만</span>
      </label>
      <p className="quiet">
        {matched.length}개{matched.length > limit ? ` 중 ${limit}개` : ''}
      </p>
      <ul className="rows">
        {matched.slice(0, limit).map(({ job, reqs }) => {
          const ok = reqs.filter((r) => r.ok).length;
          const expanded = open === job.id;
          return (
            <li key={job.id}>
              <button type="button" className="row-btn" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : job.id)}>
                <span className="row-main">
                  <strong>{job.title}</strong>
                  <span>
                    {FIELD_BY_ID.get(job.field ?? '')?.label ?? job.category} · {typesOf(job)} · 주 {job.hours ?? 40}시간
                  </span>
                </span>
                <span className="row-side num">
                  <span>{salaryRange(job, pi)}</span>
                  <span className={ok === reqs.length ? 'done' : undefined}>
                    조건 {ok}/{reqs.length}
                  </span>
                </span>
              </button>
              {expanded && <JobDetail game={game} job={job} reqs={reqs} busy={busy} run={run} />}
            </li>
          );
        })}
      </ul>
      {matched.length > limit && (
        <button type="button" className="btn small" onClick={() => setLimit(limit + PAGE)}>
          더 보기
        </button>
      )}
    </section>
  );
}

function JobDetail({
  game,
  job,
  reqs,
  busy,
  run,
}: {
  game: GameState;
  job: JobDef;
  reqs: { label: string; ok: boolean }[];
  busy: boolean;
  run: (fn: (s: GameState) => ActionResult) => void;
}) {
  const c = game.ch.career;
  const allOk = reqs.every((r) => r.ok);
  const applied = c.appliedThisYear.includes(job.id);
  const sideWhy = job.side ? sideJobBlock(game, job) : null;
  const notes = [scheduleOf(job), INJURY_LABEL[job.injury ?? 0], job.customer ? '고객 응대 많음' : '', job.noSide ? '겸직 금지' : ''].filter(Boolean);
  return (
    <div style={{ padding: '0 0.25rem 0.75rem' }}>
      <p className="quiet">{job.desc}</p>
      <ul className="chips" style={{ listStyle: 'none', margin: '0.4rem 0', padding: 0 }}>
        {reqs.map((r) => (
          <li key={r.label} className={`chip${r.ok ? '' : ' bad'}`}>
            {r.ok ? '✓' : '✗'} {r.label}
          </li>
        ))}
      </ul>
      <p className="quiet">{notes.join(' · ')}</p>
      {job.source && <p className="quiet">연봉 근거: {JOB_SOURCES[job.source] ?? job.source}</p>}
      <div className="actions">
        <button type="button" className="btn small" disabled={busy || !allOk || applied || c.jobId === job.id} onClick={() => run((s) => applyForJob(s, job.id))}>
          {applied ? '올해 지원함' : '지원하기'} <small>공고가 없으면 시간 1칸</small>
        </button>
        {job.side && (
          <button type="button" className="btn small" disabled={busy || sideWhy !== null} onClick={() => run((s) => takeSideJob(s, job.id))}>
            부업으로 <small>{sideWhy ?? '시간 1칸'}</small>
          </button>
        )}
      </div>
    </div>
  );
}

// ── 자격·면허와 직업훈련 ─────────────────────────────────

export function LicensesAndTraining({ game }: { game: GameState }) {
  const run = useRun();
  const [showAll, setShowAll] = useState(false);
  const ch = game.ch;
  const busy = game.phase !== 'action';
  const pi = game.world.economy.priceIndex;
  const records = ch.career.work?.licenses ?? {};
  const owned = LICENSES.filter((l) => records[l.id]?.passed !== undefined);
  const rows = LICENSES.filter((l) => records[l.id]?.passed === undefined || records[l.id]?.lapsed)
    .map((l) => ({ l, why: licenseBlock(game, l) }))
    .sort((a, b) => Number(a.why !== null) - Number(b.why !== null));
  const shown = showAll ? rows : rows.filter((r) => r.why === null).slice(0, 8);
  if (ch.age < 15) return null;
  return (
    <section className="group">
      <h3 className="label">자격·면허</h3>
      {owned.length > 0 ? (
        <ul className="rows">
          {owned.map((l) => {
            const r = records[l.id];
            const due = r.renewAt !== undefined && ch.age + 1 >= r.renewAt;
            return (
              <li key={l.id}>
                <button type="button" className="row-btn" disabled={busy || !due} onClick={() => run((s) => studyLicense(s, l.id))}>
                  <span className="row-main">
                    <strong>{l.name}</strong>
                    <span>
                      {r.passed}세 취득{r.renewAt !== undefined ? ` · ${r.renewAt}세 갱신` : ''}
                      {r.lapsed ? ' · 효력 정지' : ''}
                    </span>
                  </span>
                  <span className="row-side">{due ? <span>갱신하기</span> : <span className="done">보유</span>}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="plain">아직 자격·면허가 없다.</p>
      )}
      <ul className="rows">
        {shown.map(({ l, why }) => {
          const tries = records[l.id]?.tries ?? 0;
          return (
            <li key={l.id}>
              <button type="button" className="row-btn" disabled={busy || why !== null} onClick={() => run((s) => studyLicense(s, l.id))}>
                <span className="row-main">
                  <strong>{l.name}</strong>
                  <span>
                    {l.kind} · {formatWonShort(Math.round(l.cost * pi))} · 시간 {l.points}칸{tries > 0 ? ` · ${tries}번 응시` : ''}
                    {why ? ` · ${why}` : ''}
                  </span>
                </span>
                <span className="row-side num">{why ? '' : `합격 약 ${Math.round(licensePassChance(game, l) * 100)}%`}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn small" onClick={() => setShowAll(!showAll)}>
        {showAll ? '응시할 수 있는 것만 보기' : `자격 ${rows.length}개 모두 보기`}
      </button>

      {ch.age >= 19 && ch.age <= 64 && (
        <>
          <h3 className="label">직업훈련 (국민내일배움카드)</h3>
          <ul className="rows">
            {Object.entries(TRAINING_TRACKS).map(([id, t]) => {
              const enrolled = Boolean(ch.flags[`work_train_${id}`]);
              const done = ch.career.work?.trained?.includes(id);
              return (
                <li key={id}>
                  <button type="button" className="row-btn" disabled={busy || enrolled} onClick={() => run((s) => startTraining(s, id))}>
                    <span className="row-main">
                      <strong>{t.label}</strong>
                      <span>
                        {t.desc} · 자부담 {formatWonShort(Math.round(t.cost * pi))} · 시간 {t.points}칸
                      </span>
                    </span>
                    <span className="row-side">{enrolled ? <span>수강 중</span> : done ? <span className="done">수료</span> : null}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
