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
  version: number;
  createdAt: string;
  updatedAt: string;
  permissions: Permissions;
}

export interface ProcessRow {
  id: string;
  title: string;
  status: ProcessStatus;
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
}

export interface Board {
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
