import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { Board, BoardCard } from '../../api/types';
import { Button, DecisionBadge, Empty } from '../../components/ui';
import { MoveDialog } from '../../components/MoveDialog';
import { daysSince } from '../../lib/format';

export function BoardView({ board }: { board: Board }) {
  const qc = useQueryClient();
  const { process, stages, cards } = board;
  const canMove = process.permissions.canMoveStage && process.status === 'em_andamento';
  const [moving, setMoving] = useState<{ card: BoardCard; target?: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<number | null>(null);

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
                      </div>
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
