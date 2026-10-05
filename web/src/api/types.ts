export type UserKind = 'alpha_admin' | 'alpha_staff' | 'client_user' | 'client_manager';
export type ProcessStatus = 'em_andamento' | 'concluido' | 'arquivado';
export type Decision = 'pendente' | 'aprovado' | 'reprovado' | 'desistiu';
export type Visibility = 'internal' | 'shared';

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  kind: UserKind;
  companyId: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Stage {
  id: number;
  key: string;
  name: string;
  position: number;
}

export interface Company {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  processCount?: number;
  activeUsers?: number;
  cnpj?: string | null;
  billingEmail?: string | null;
}

export interface UserRow {
  id: string;
  email: string;
  fullName: string;
  kind: UserKind;
  companyId: string | null;
  companyName: string | null;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  accessStatus: 'senha_definida' | 'convite_pendente' | 'sem_convite_valido' | null;
}

export interface Permissions {
  isMember: boolean;
  canManage: boolean;
  canAddCandidates: boolean;
  canMoveStage: boolean;
  canDecide: boolean;
  canComment: boolean;
  canSeeInternal: boolean;
}

export interface Process {
  id: string;
  companyId: string;
  companyName: string;
  title: string;
  description: string | null;
  status: ProcessStatus;
  publication?: Publication;
  publicSlug?: string | null;
  slaDays?: number;
  evaluationCriteria?: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  permissions: Permissions;
}

export interface ProcessRow {
  id: string;
  title: string;
  status: ProcessStatus;
  publication?: Publication;
  companyId: string;
  companyName: string;
  updatedAt: string;
  candidateCount: number;
  openCount: number;
}

export interface Member {
  userId: string;
  fullName: string;
  kind: UserKind;
  isActive: boolean;
  canMoveStage: boolean;
  canDecide: boolean;
  canComment: boolean;
}

export interface BoardCard {
  id: string;
  stageId: number;
  decision: Decision;
  version: number;
  stageChangedAt: string;
  ownerId: string | null;
  ownerName: string | null;
  candidateName: string;
  documentCount: number;
  commentCount: number;
  source?: 'interno' | 'portal';
  screeningFailed?: boolean | null;
  decisionReason?: Reason | null;
  sentAt?: string | null;
  triageStatus?: TriageStatus | null;
  score?: number | null;
  slaOverdue?: boolean;
}

export interface Funnel {
  total: number;
  emTriagem: number;
  aprovadosInternos: number;
  enviados: number;
  aprovados: number;
}

export interface Board {
  funnel?: Funnel;
  process: Process;
  stages: Stage[];
  cards: BoardCard[];
}

export interface CandidateRow {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  updatedAt: string;
  applicationCount: number;
  documentCount: number;
}

export interface DocumentRow {
  id: string;
  kind: 'curriculo' | 'documento' | 'outro';
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
  uploadedByName: string | null;
  uploadedBy?: string | null;
  sharedWithClient?: boolean;
}

export interface CandidateApplication {
  id: string;
  processId: string;
  processTitle: string;
  companyName: string;
  processStatus: ProcessStatus;
  stageId: number;
  decision: Decision;
  ownerName: string | null;
  updatedAt: string;
}

export interface Candidate {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  salaryExpectation: number | null;
  notes: string | null;
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
  source?: 'interno' | 'portal';
  city?: string | null;
  emailOptOutAt?: string | null;
  consentAt?: string | null;
  applications: CandidateApplication[];
  documents: DocumentRow[];
}

export interface Application {
  id: string;
  stageId: number;
  stageName: string;
  decision: Decision;
  version: number;
  ownerId: string | null;
  ownerName: string | null;
  stageChangedAt: string;
  createdAt: string;
  updatedAt: string;
  sharedSummary: string | null;
  source?: 'interno' | 'portal';
  decisionReason?: Reason | null;
  sentAt?: string | null;
  shareEmail?: boolean;
  sharePhone?: boolean;
  shareSalary?: boolean;
  candidateId: string | null;
  candidateName: string;
  candidateEmail: string | null;
  candidatePhone: string | null;
  candidateSalary: number | null;
  process: Omit<Process, 'permissions'>;
  permissions: Permissions;
}

export interface Comment {
  id: string;
  visibility: Visibility;
  body: string;
  createdAt: string;
  updatedAt: string;
  edited: boolean;
  authorId: string | null;
  authorName: string | null;
}

export interface HistoryItem {
  id: number;
  event: 'created' | 'changed';
  fromStageId: number | null;
  toStageId: number | null;
  fromDecision: Decision | null;
  toDecision: Decision | null;
  fromOwnerId: string | null;
  toOwnerId: string | null;
  fromOwnerName: string | null;
  toOwnerName: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface Dashboard {
  totals: { activeProcesses: number; candidates: number; openApplications: number };
  leads?: { inTriage: number; sentLast30: number; overdue: number };
  awaiting?: { id: string; candidateName: string; processTitle: string; stageName: string; stageChangedAt: string; overdue: boolean }[];
  byProcess?: { id: string; title: string; companyName: string; sent: number; pending: number; approved: number; rejected: number; avgResponseDays: number | null }[];
  byStage: { stageId: number; name: string; count: number }[];
  myPending: { id: string; candidateName: string; processTitle: string; stageName: string; stageChangedAt: string }[];
  recent: {
    id: number;
    applicationId: string;
    event: 'created' | 'changed';
    createdAt: string;
    fromStage: string | null;
    toStage: string | null;
    fromDecision: Decision | null;
    toDecision: Decision | null;
    candidateName: string;
    processTitle: string;
    actorName: string | null;
  }[];
}

export interface AuditRow {
  id: number;
  occurredAt: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  actorName: string | null;
  companyName: string | null;
}

export interface SignupRow {
  id: string;
  companyName: string;
  cnpj: string | null;
  fullName: string;
  email: string;
  phone: string | null;
  status: 'pendente' | 'aprovado' | 'recusado';
  emailVerifiedAt: string | null;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  companyId: string | null;
  decidedByName: string | null;
  matchingCompanyId: string | null;
}

export type ChargeSituacao = 'pendente' | 'vencida' | 'pago' | 'cancelado';
export type NoticeKind = 'criada' | 'lembrete' | 'vencimento' | 'atraso' | 'pagamento' | 'manual';

export interface ChargeRow {
  id: string;
  companyId: string;
  companyName: string;
  description: string;
  amountCents: number;
  dueDate: string;
  billingEmail: string;
  paymentLink: string | null;
  status: 'pendente' | 'pago' | 'cancelado';
  situacao: ChargeSituacao;
  paidAt: string | null;
  paidNote: string | null;
  canceledAt: string | null;
  remindersPaused: boolean;
  recurrence: 'nenhuma' | 'mensal';
  seriesIndex: number;
  createdAt: string;
  version: number;
  lastNotice: { kind: NoticeKind; sentAt: string; ok: boolean } | null;
}

export interface ChargeDetail extends ChargeRow {
  notices: { id: string; kind: NoticeKind; sentTo: string; ok: boolean; error: string | null; sentAt: string }[];
}

export interface BillingSummary {
  openCents: number;
  openCount: number;
  overdueCents: number;
  overdueCount: number;
  paidMonthCents: number;
  paidMonthCount: number;
  emailEnabled: boolean;
  autoEmail: boolean;
  today: string;
}

export interface BillingSettings {
  autoEmail: boolean;
  pixKey: string | null;
  beneficiary: string | null;
  instructions: string | null;
  reminderDaysBefore: number;
  overdueEveryDays: number;
  overdueMaxReminders: number;
  emailEnabled: boolean;
}

export type Publication = 'rascunho' | 'publicada' | 'pausada' | 'encerrada';
export type WorkModel = 'presencial' | 'hibrido' | 'remoto';
export type EmploymentType = 'clt' | 'pj' | 'estagio' | 'temporario' | 'outro';

export interface ScreeningQuestion {
  id?: string;
  text: string;
  eliminatory: boolean;
  expected: 'sim' | 'nao';
}

export interface JobConfig {
  jobLocation: string | null;
  workModel: WorkModel | null;
  employmentType: EmploymentType | null;
  requirements: string | null;
  benefits: string | null;
  salaryMinCents: number | null;
  salaryMaxCents: number | null;
  showCompany: boolean;
  publication: Publication;
  publicSlug: string | null;
  publishedAt: string | null;
  screeningQuestions: ScreeningQuestion[];
  version: number;
  status: ProcessStatus;
}

export interface PublicJob {
  slug: string;
  title: string;
  location: string | null;
  workModel: WorkModel | null;
  employmentType: EmploymentType | null;
  publishedAt: string | null;
  companyName: string | null;
  salaryMinCents: number | null;
  salaryMaxCents: number | null;
}

export interface PublicJobDetail extends PublicJob {
  description: string | null;
  requirements: string | null;
  benefits: string | null;
  questions: { id: string; text: string }[];
}

export interface Intake {
  answers: { id: string; text: string; eliminatory: boolean; expected: 'sim' | 'nao'; answer: 'sim' | 'nao' }[];
  screeningFailed: boolean;
  createdAt: string;
}

export type TriageStatus = 'em_triagem' | 'aprovado_interno' | 'reprovado_interno';
export type Reason =
  | 'perfil_tecnico' | 'experiencia' | 'pretensao_salarial' | 'localizacao' | 'disponibilidade'
  | 'comportamental' | 'sem_retorno' | 'vaga_cancelada' | 'desistencia_candidato' | 'outro';

export interface Evaluation {
  triageStatus: TriageStatus;
  ratings: { criterion: string; score: number }[];
  score: number | null;
  reason: Reason | null;
  notes: string | null;
  version: number;
  updatedAt: string;
  evaluatedByName: string | null;
}

export interface Interview {
  id: string;
  scheduledAt: string;
  mode: 'presencial' | 'online' | 'telefone';
  location: string | null;
  notes: string | null;
  status: 'agendada' | 'realizada' | 'cancelada';
  version: number;
  createdByName: string | null;
  createdAt: string;
}

export interface MessageTemplate {
  key: 'candidatura_recebida' | 'perfil_enviado' | 'entrevista_agendada' | 'reprovacao';
  enabled: boolean;
  subject: string;
  body: string;
  updatedAt: string;
}

export interface MessageLogRow {
  id: string;
  templateKey: MessageTemplate['key'];
  candidateId: string;
  candidateName: string;
  to: string;
  subject: string;
  ok: boolean;
  error: string | null;
  sentAt: string;
}
