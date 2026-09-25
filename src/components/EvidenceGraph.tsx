import { useMemo, useState } from 'react';
import type { Evidence, Hypothesis, Investigation } from '@/domain/types';
import { SOURCE_LABELS } from '@/domain/defaults';
import { fmtConfidence } from '@/lib/format';
import { unexplainedMass } from '@/agents/hypotheses';

/**
 * Signal → evidence → hypotheses. Edges from evidence to a hypothesis are the scorer's weights:
 * solid = supports, dashed = contradicts. Select a hypothesis to see what it rests on.
 */

const W = 820;
const NODE_H = 40;
const GAP = 8;
const COL = { left: { x: 4, w: 150 }, mid: { x: 212, w: 330 }, right: { x: 598, w: 218 } };

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Greedy word wrap into at most `max` lines. */
function wrap(s: string, width: number, max = 2): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of s.split(' ')) {
    if ((line + ' ' + word).trim().length > width && line) {
      lines.push(line);
      line = word;
    } else line = (line + ' ' + word).trim();
  }
  if (line) lines.push(line);
  if (lines.length > max) {
    const kept = lines.slice(0, max);
    kept[max - 1] = truncate(`${kept[max - 1]} ${lines[max]}`, width);
    return kept;
  }
  return lines;
}

const showValue = (e: Evidence) => !!e.value && !e.title.toLowerCase().includes(e.value.toLowerCase());

export function EvidenceGraph({ inv, onSelect, selectedId }: { inv: Investigation; onSelect: (e: Evidence) => void; selectedId?: string }) {
  const [focusH, setFocusH] = useState<string | undefined>(inv.leadingHypothesisId ?? inv.hypotheses[0]?.id);
  const anomaly = inv.evidence.find((e) => e.kind === 'anomaly');
  const hyps = inv.hypotheses.slice(0, 4);
  const focus = hyps.find((h) => h.id === focusH);

  const evidence = useMemo(() => {
    const rank = (e: Evidence) => (e.stance === 'supports' ? 0 : e.stance === 'context' ? 1 : e.stance === 'contradicts' ? 2 : 3);
    const w = (e: Evidence) => Math.abs(inv.hypotheses[0]?.weights.find((x) => x.evidenceId === e.id)?.weight ?? 0);
    return inv.evidence.filter((e) => e.kind !== 'anomaly').sort((a, b) => rank(a) - rank(b) || w(b) - w(a));
  }, [inv]);

  const midH = evidence.length * (NODE_H + GAP) - GAP;
  const rightH = (hyps.length + 1) * (NODE_H + 30 + GAP) - GAP;
  const H = Math.max(midH, rightH, 120) + 32;
  const y0 = 16;
  const evY = (i: number) => y0 + i * (NODE_H + GAP);
  const hypBlock = NODE_H + 30;
  const hypTop = y0 + Math.max(0, (midH - rightH) / 2);
  const hY = (i: number) => hypTop + i * (hypBlock + GAP);
  const aY = y0 + midH / 2 - 44;

  const weightOf = (h: Hypothesis | undefined, e: Evidence) => h?.weights.find((w) => w.evidenceId === e.id)?.weight ?? 0;
  const stroke = (s: Evidence['stance']) => (s === 'supports' ? 'var(--ok)' : s === 'contradicts' ? 'var(--crit)' : s === 'gap' ? 'var(--high)' : 'var(--line-strong)');

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[680px]" role="img" aria-label="Evidence graph">
        {/* anomaly → evidence */}
        {evidence.map((e, i) => {
          const x1 = COL.left.x + COL.left.w;
          const y1 = aY + 44;
          const x2 = COL.mid.x;
          const y2 = evY(i) + NODE_H / 2;
          return <path key={`a-${e.id}`} d={`M${x1},${y1} C${x1 + 40},${y1} ${x2 - 40},${y2} ${x2},${y2}`} fill="none" stroke="var(--line)" strokeWidth={1} />;
        })}
        {/* evidence → focused hypothesis */}
        {focus &&
          evidence.map((e, i) => {
            const w = weightOf(focus, e);
            if (Math.abs(w) < 0.1) return null;
            const hi = hyps.findIndex((h) => h.id === focus.id);
            const x1 = COL.mid.x + COL.mid.w;
            const y1 = evY(i) + NODE_H / 2;
            const x2 = COL.right.x;
            const y2 = hY(hi) + hypBlock / 2;
            return (
              <path
                key={`h-${e.id}`}
                d={`M${x1},${y1} C${x1 + 40},${y1} ${x2 - 40},${y2} ${x2},${y2}`}
                fill="none"
                stroke={w > 0 ? 'var(--ok)' : 'var(--crit)'}
                strokeWidth={Math.min(3, 0.8 + Math.abs(w) * 2)}
                strokeDasharray={w > 0 ? undefined : '4 3'}
                opacity={0.75}
              />
            );
          })}

        {/* anomaly node */}
        {anomaly && (
          <g className="cursor-pointer" onClick={() => onSelect(anomaly)}>
            <rect x={COL.left.x} y={aY} width={COL.left.w} height={88} rx={10} fill="var(--crit-soft)" stroke="var(--crit)" strokeOpacity={0.5} />
            <text x={COL.left.x + 12} y={aY + 20} fontSize="10.5" fill="var(--crit)" fontWeight={600} letterSpacing="0.06em">
              SIGNAL
            </text>
            {wrap(anomaly.title.replace(/ (down|up) .*/, ''), 18).map((line, li) => (
              <text key={li} x={COL.left.x + 12} y={aY + 38 + li * 15} fontSize="12.5" fill="var(--ink)" fontWeight={600}>
                {line}
              </text>
            ))}
            <text x={COL.left.x + 12} y={aY + 76} fontSize="13" fill="var(--crit)" fontWeight={600} className="tabular">
              {anomaly.value}
            </text>
          </g>
        )}

        {/* evidence nodes */}
        {evidence.map((e, i) => {
          const y = evY(i);
          const sel = selectedId === e.id;
          return (
            <g key={e.id} className="cursor-pointer" onClick={() => onSelect(e)} role="button" aria-label={e.title}>
              <rect x={COL.mid.x} y={y} width={COL.mid.w} height={NODE_H} rx={8} fill="var(--surface)" stroke={sel ? 'var(--ink)' : 'var(--line)'} strokeWidth={sel ? 1.5 : 1} />
              <rect x={COL.mid.x} y={y} width={3} height={NODE_H} rx={1.5} fill={stroke(e.stance)} />
              <text x={COL.mid.x + 12} y={y + 17} fontSize="12" fill="var(--ink)" fontWeight={500}>
                {truncate(e.title, showValue(e) ? 40 : 50)}
              </text>
              <text x={COL.mid.x + 12} y={y + 31} fontSize="10.5" fill="var(--ink-3)">
                {SOURCE_LABELS[e.source]} · {e.stance === 'gap' ? 'source unavailable' : e.stance}
              </text>
              {showValue(e) && (
                <text x={COL.mid.x + COL.mid.w - 10} y={y + 24} fontSize="11.5" textAnchor="end" fill="var(--ink-2)" fontWeight={600} className="tabular">
                  {truncate(e.value ?? '', 12)}
                </text>
              )}
            </g>
          );
        })}

        {/* hypotheses */}
        {hyps.map((h, i) => {
          const y = hY(i);
          const active = h.id === focusH;
          const leading = h.id === inv.leadingHypothesisId;
          return (
            <g key={h.id} className="cursor-pointer" onClick={() => setFocusH(h.id)} role="button" aria-label={`Show evidence for ${h.statement}`}>
              <rect x={COL.right.x} y={y} width={COL.right.w} height={hypBlock} rx={10} fill={active ? 'var(--accent-soft)' : 'var(--surface)'} stroke={active ? 'var(--accent)' : 'var(--line)'} />
              <text x={COL.right.x + 12} y={y + 18} fontSize="10" fill={leading ? 'var(--accent)' : 'var(--ink-3)'} fontWeight={600} letterSpacing="0.06em">
                {leading ? 'LEADING HYPOTHESIS' : 'ALTERNATIVE'}
              </text>
              {wrap(h.statement, 34).map((line, li) => (
                <text key={li} x={COL.right.x + 12} y={y + 34 + li * 14} fontSize="11.5" fill="var(--ink)" fontWeight={500}>
                  {line}
                </text>
              ))}
              <rect x={COL.right.x + 12} y={y + 57} width={COL.right.w - 60} height={4} rx={2} fill="var(--muted)" />
              <rect x={COL.right.x + 12} y={y + 57} width={(COL.right.w - 60) * h.confidence} height={4} rx={2} fill={leading ? 'var(--ink)' : 'var(--ink-3)'} />
              <text x={COL.right.x + COL.right.w - 10} y={y + 62} fontSize="11" textAnchor="end" fill="var(--ink)" fontWeight={600} className="tabular">
                {fmtConfidence(h.confidence)}
              </text>
            </g>
          );
        })}
        {hyps.length > 0 && (
          <g>
            <rect x={COL.right.x} y={hY(hyps.length)} width={COL.right.w} height={hypBlock} rx={10} fill="none" stroke="var(--line-strong)" strokeDasharray="4 3" />
            <text x={COL.right.x + 12} y={hY(hyps.length) + 22} fontSize="11.5" fill="var(--ink-2)" fontWeight={500}>
              Unexplained / unobservable
            </text>
            <text x={COL.right.x + 12} y={hY(hyps.length) + 40} fontSize="10.5" fill="var(--ink-3)">
              Reserved probability · {fmtConfidence(unexplainedMass(inv.hypotheses))}
            </text>
          </g>
        )}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-3">
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 bg-ok" /> Supports selected hypothesis</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-0 w-4 border-t-2 border-dashed border-crit" /> Contradicts</span>
        <span>Click evidence to inspect source data · click a hypothesis to see what it rests on</span>
      </div>
    </div>
  );
}
