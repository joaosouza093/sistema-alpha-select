import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { Board, BoardCard } from '../../api/types';
import { Button, DecisionBadge, Empty } from '../../components/ui';
import { MoveDialog } from '../../components/MoveDialog';
import { SendLeadsModal } from '../../components/SendLeadsModal';
import { useAuth } from '../../auth/AuthContext';
import { daysSince, fmtScore, reasonLabel, triageLabel } from '../../lib/format';

const triageBadge = { em_triagem: 'badge-info', aprovado_interno: 'badge-success', reprovado_interno: 'badge-danger' } as const;

export function BoardView({ board }: { board: Board }) {
  const qc = useQueryClient();
  const { process, stages, cards } = board;
  const canMove = process.permissions.canMoveStage && process.status === 'em_andamento';
  const [moving, setMoving] = useState<{ card: BoardCard; target?: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<number | null>(null);
  const { isAlpha } = useAuth();
  const canSend = isAlpha && canMove;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState<BoardCard[] | null>(null);
  const sendable = (c: BoardCard) => !c.sentAt && c.decision === 'pendente' && c.triageStatus === 'aprovado_interno';
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (cards.length === 0) {
    return (
      <div className="card">
        <Empty title="Nenhum candidato neste processo">
          {process.permissions.canAddCandidates ? 'Use “Incluir candidato” para adicionar participantes.' : 'Os candidatos aparecerão aqui quando forem incluídos.'}
        </Empty>
      </div>
    );
  }

  return (
    <>
      {isAlpha && board.funnel && (
        <div className="funnel" aria-label="Funil do processo">
          <span><strong>{board.funnel.total}</strong> candidatos</span>
          <span><strong>{board.funnel.emTriagem}</strong> em triagem</span>
          <span><strong>{board.funnel.aprovadosInternos}</strong> aprovados na triagem</span>
          <span><strong>{board.funnel.enviados}</strong> enviados ao cliente</span>
          <span><strong>{board.funnel.aprovados}</strong> aprovados</span>
          {process.slaDays && <span className="muted">Prazo por etapa: {process.slaDays} dia(s)</span>}
        </div>
      )}
      {canSend && cards.some(sendable) && (
        <div className="row" style={{ marginBottom: 8 }}>
          <Button variant="primary" disabled={selected.size === 0} onClick={() => setSending(cards.filter((c) => selected.has(c.id)))}>
            Enviar selecionados ao cliente ({selected.size})
          </Button>
          <span className="muted small">Marque os aprovados na triagem na coluna 1.</span>
        </div>
      )}
      <p className="muted small" style={{ marginTop: 0 }}>
        {canMove ? 'Arraste um cartão para a coluna vizinha ou use os botões do cartão (acessíveis por teclado).' : 'Você pode consultar o quadro; movimentações dependem de permissão.'}
      </p>
      <div className="board">
        {stages.map((s) => {
          const col = cards.filter((c) => c.stageId === s.id);
          return (
            <section
              key={s.id}
              className={`column ${overStage === s.id ? 'drop-target' : ''}`}
              aria-labelledby={`col-${s.id}`}
              onDragOver={(e) => {
                if (!canMove || !dragId) return;
                e.preventDefault();
                setOverStage(s.id);
              }}
              onDragLeave={() => setOverStage((v) => (v === s.id ? null : v))}
              onDrop={(e) => {
                e.preventDefault();
                setOverStage(null);
                const card = cards.find((c) => c.id === dragId);
                setDragId(null);
                if (card && card.stageId !== s.id) setMoving({ card, target: s.id });
              }}
            >
              <div className="column-header">
                <h2 id={`col-${s.id}`} style={{ fontSize: '.95rem' }}>
                  {s.position}. {s.name}
                </h2>
                <span className="badge">{col.length}</span>
              </div>
              <div className="column-body">
                {col.map((c) => {
                  const idx = stages.findIndex((x) => x.id === c.stageId);
                  const prev = stages[idx - 1];
                  const next = stages[idx + 1];
                  const locked = c.decision !== 'pendente';
                  return (
                    <article
                      key={c.id}
                      className={`kcard ${dragId === c.id ? 'dragging' : ''}`}
                      draggable={canMove && !locked}
                      onDragStart={(e) => {
                        setDragId(c.id);
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', c.id);
                      }}
                      onDragEnd={() => setDragId(null)}
                      aria-label={`Candidato ${c.candidateName}`}
                    >
                      <Link to={`/participacoes/${c.id}`} className="kcard-title">
                        {c.candidateName}
                      </Link>
                      <div className="row" style={{ gap: 4 }}>
                        <DecisionBadge decision={c.decision} />
                        {c.source === 'portal' && <span className="badge badge-brand">Portal</span>}
                        {c.screeningFailed && <span className="badge badge-warning" title="Respondeu diferente do exigido em pergunta eliminatória">Não atende requisito</span>}
                        {c.triageStatus && !c.sentAt && <span className={`badge ${triageBadge[c.triageStatus]}`}>{triageLabel[c.triageStatus]}</span>}
                        {fmtScore(c.score) && <span className="badge">Nota {fmtScore(c.score)}</span>}
                        {c.slaOverdue && <span className="badge badge-danger" title="Parado na etapa além do prazo combinado">Prazo vencido</span>}
                      </div>
                      {c.decisionReason && <div className="kcard-meta"><span>Motivo: {reasonLabel[c.decisionReason]}</span></div>}
                      {canSend && sendable(c) && (
                        <label className="checkbox small">
                          <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                          <span>Selecionar para envio</span>
                        </label>
                      )}
                      <div className="kcard-meta">
                        <span>Responsável: {c.ownerName ?? '—'}</span>
                      </div>
                      <div className="kcard-meta">
                        <span>Na etapa {daysSince(c.stageChangedAt)}</span>
                      </div>
                      <div className="kcard-meta">
                        <span>{c.documentCount} {c.documentCount === 1 ? 'documento' : 'documentos'}</span>
                        <span aria-hidden>·</span>
                        <span>{c.commentCount} {c.commentCount === 1 ? 'comentário' : 'comentários'}</span>
                      </div>
                      {canMove && !locked && (
                        <div className="kcard-actions">
                          {prev && (
                            <Button size="sm" onClick={() => setMoving({ card: c, target: prev.id })} aria-label={`Voltar ${c.candidateName} para ${prev.name}`}>
                              ← {prev.name}
                            </Button>
                          )}
                          {next && (
                            <Button size="sm" onClick={() => setMoving({ card: c, target: next.id })} aria-label={`Avançar ${c.candidateName} para ${next.name}`}>
                              {next.name} →
                            </Button>
                          )}
                        </div>
                      )}
                      {locked && canMove && <span className="muted small">Decisão registrada: reabra para mover.</span>}
                    </article>
                  );
                })}
                {col.length === 0 && <p className="muted small" style={{ textAlign: 'center', margin: '12px 0' }}>Sem candidatos</p>}
              </div>
            </section>
          );
        })}
      </div>
      {sending && (
        <SendLeadsModal processId={process.id} candidates={sending.map((c) => ({ applicationId: c.id, name: c.candidateName }))}
          onClose={() => setSending(null)} onDone={() => { setSending(null); setSelected(new Set()); }} />
      )}
      {moving && (
        <MoveDialog
          applicationId={moving.card.id}
          candidateName={moving.card.candidateName}
          currentStageId={moving.card.stageId}
          currentOwnerId={moving.card.ownerId}
          version={moving.card.version}
          stages={stages}
          initialTargetId={moving.target}
          onClose={() => setMoving(null)}
          onDone={() => {
            setMoving(null);
            void qc.invalidateQueries({ queryKey: ['board', process.id] });
          }}
        />
      )}
    </>
  );
}
